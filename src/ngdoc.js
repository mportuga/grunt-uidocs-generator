/**
 * All parsing/transformation code goes here. All code here should be sync to ease testing.
 */
var DOM = require('./dom.js').DOM;
var htmlEscape = require('./dom.js').htmlEscape;
var Example = require('./example.js').Example;
var NEW_LINE = /\n\r?/;
var globalID = 0;
var fs = require('fs');
var fspath = require('path');
var errorsJson;
var marked = require('marked');
var renderer = new marked.Renderer();
renderer.heading = function (text, level) {
  return '<h' +
    level +
    '>' +
    text +
    '</h' +
    level +
    '>\n';
};
marked.setOptions({
  renderer: renderer,
  gfm: true,
  tables: true
});

var lookupMinerrMsg = function (doc) {
  var code, namespace;

  if (errorsJson === undefined) {
    errorsJson = require(exports.errorFile).errors;
  }

  namespace = doc.getMinerrNamespace();
  code = doc.getMinerrCode();
  if (namespace === undefined) {
    return errorsJson[code];
  }
  return errorsJson[namespace][code];
};

exports.trim = trim;
exports.metadata = metadata;
exports.scenarios = scenarios;
exports.merge = merge;
exports.checkBrokenLinks = checkBrokenLinks;
exports.Doc = Doc;

var BOOLEAN_ATTR = {};
['multiple', 'selected', 'checked', 'disabled', 'readOnly', 'required'].forEach(function(value) {
  BOOLEAN_ATTR[value] = true;
});

//////////////////////////////////////////////////////////
function Doc(text, file, startLine, endLine, options) {
  if (typeof text == 'object') {
    for ( var key in text) {
      this[key] = text[key];
    }
  } else {
    this.text = text;
    this.file = file;
    this.line = startLine;
    this.codeline = endLine + 1;
  }
  this.options = options || {};
  this.scenarios = this.scenarios || [];
  this.requires = this.requires || [];
  this.param = this.param || [];
  this.properties = this.properties || [];
  this.methods = this.methods || [];
  this.events = this.events || [];
  this.links = this.links || [];
  this.anchors = this.anchors || [];
}
Doc.METADATA_IGNORE = (function() {
  var words = fs.readFileSync(__dirname + '/ignore.words', 'utf8');
  return words.toString().split(/[,\s\n\r]+/gm);
})();


Doc.prototype = {
  keywords: function keywords() {
    var keywords = {};
    var words = [];
    Doc.METADATA_IGNORE.forEach(function(ignore){ keywords[ignore] = true; });

    function extractWords(text) {
      var tokens = text.toLowerCase().split(/[\.\s,`'"#]+/mg);
      tokens.forEach(function(key){
        var match = key.match(/^((ng:|[\$_a-z])[\w\-_]+)/);
        if (match){
          key = match[1];
          if (!keywords[key]) {
            keywords[key] = true;
            words.push(key);
          }
        }
      });
    }

    extractWords(this.text);
    this.properties.forEach(function(prop) {
      extractWords(prop.text || prop.description || '');
    });
    this.methods.forEach(function(method) {
      extractWords(method.text || method.description || '');
    });
    if (this.ngdoc === 'error') {
      words.push(this.getMinerrNamespace());
      words.push(this.getMinerrCode());
    }
    words.sort();
    return words.join(' ');
  },

  shortDescription : function() {
    if (!this.description) return this.description;
    var text = this.description.split("\n")[0];
    text = text.replace(/<.+?\/?>/g, '');
    text = text.replace(/{/g,'&#123;');
    text = text.replace(/}/g,'&#125;');
    return text;
  },

  getMinerrNamespace: function () {
    if (this.ngdoc !== 'error') {
      throw new Error('Tried to get the minErr namespace, but @ngdoc ' +
        this.ngdoc + ' was supplied. It should be @ngdoc error');
    }
    return this.name.split(':')[0];
  },

  getMinerrCode: function () {
    if (this.ngdoc !== 'error') {
      throw new Error('Tried to get the minErr error code, but @ngdoc ' +
        this.ngdoc + ' was supplied. It should be @ngdoc error');
    }
    return this.name.split(':')[1];
  },

  /**
   * Converts relative urls (without section) into absolute
   * Absolute url means url with section
   *
   * @example
   * - if the link is inside any api doc:
   * angular.widget -> api/angular.widget
   *
   * - if the link is inside any guid doc:
   * intro -> guide/intro
   *
   * @param {string} url Absolute or relative url
   * @returns {string} Absolute url
   */
  convertUrlToAbsolute: function(url) {
    if (url.match(/^(https?:\/\/|ftps?:\/\/|mailto:|\.|\/)/)) return url;
    var prefix = this.options.html5Mode ? '' : '#!/';
    var hashIdx = url.indexOf('#');

    // Lowercase hash parts of the links,
    // so that we can keep correct API names even when the urls are lowercased.
    if (hashIdx !== -1) {
      url = url.substr(0, hashIdx) + url.substr(hashIdx).toLowerCase();
    }

    if (url.substr(-1) == '/') return prefix + url + 'index';
    if (url.match(/\//)) return prefix + url;
    return prefix + this.section + '/' + url;
  },

  markdown: function(text) {
    if (!text) return text;

    var self = this,
      IS_URL = /^(https?:\/\/|ftps?:\/\/|mailto:|\.|\/)/,
      IS_ANGULAR = /^(api\/)?(angular|ng|AUTO)\./,
      IS_HASH = /^#/,
      parts = trim(text).split(/(<pre.*?>[\s\S]*?<\/pre>|<doc:example(\S*).*?>[\s\S]*?<\/doc:example>|<example[^>]*>[\s\S]*?<\/example>)/),
      seq = 0,
      placeholderMap = {};

    function placeholder(text) {
      var id = 'REPLACEME' + (seq++);
      placeholderMap[id] = text;
      return id;
    }

    function extractInlineDocCode(text, tag) {
      var regex;

      if(tag == 'all') {
        //use a greedy operator to match the last </docs> tag
        regex = /\/\/<docs.*?>([.\s\S]+)\/\/<\/docs>/im;
      }
      else {
        //use a non-greedy operator to match the next </docs> tag
        regex = new RegExp("\/\/<docs\\s*tag=\"" + tag + "\".*?>([.\\s\\S]+?)\/\/<\/docs>","im");
      }
      var matches = regex.exec(text.toString());
      return matches && matches.length > 1 ? matches[1] : "";
    }

    parts.forEach(function(text, i) {
      parts[i] = (text || '').
        replace(/<example(?:\s+module="([^"]*)")?(?:\s+deps="([^"]*)")?(\s+animations="true")?>([\s\S]*?)<\/example>/gmi,
          function(_, module, deps, animations, content) {

          var example = new Example(self.scenarios);
          if(animations) {
            example.enableAnimations();
            example.addDeps('angular-animate.js');
          }

          example.setModule(module);
          example.addDeps(deps);
          content.replace(/<file\s+name="([^"]*)"\s*>([\s\S]*?)<\/file>/gmi, function(_, name, content) {
            example.addSource(name, content);
          });
          content.replace(/<file\s+src="([^"]+)"(?:\s+tag="([^"]+)")?(?:\s+name="([^"]+)")?\s*\/?>/gmi, function(_, file, tag, name) {
            if(fs.existsSync(file)) {
              var content = fs.readFileSync(file, 'utf8');
              if(content && content.length > 0) {
                if(tag && tag.length > 0) {
                  content = extractInlineDocCode(content, tag);
                }
                name = name && name.length > 0 ? name : fspath.basename(file);
                example.addSource(name, content);
              }
            }
            return '';
          });
          return placeholder(example.toHtml());
        }).
        replace(/(?:\*\s+)?<file.+?src="([^"]+)"(?:\s+tag="([^"]+)")?\s*\/?>/i, function(_, file, tag) {
          if(fs.existsSync(file)) {
            var content = fs.readFileSync(file, 'utf8');
            if(tag && tag.length > 0) {
              content = extractInlineDocCode(content, tag);
            }
            return content;
          }
        }).
        replace(/^<doc:example(\s+[^>]*)?>([\s\S]*)<\/doc:example>/mi, function(_, attrs, content) {
          var html, script, scenario,
            example = new Example(self.scenarios);

          example.setModule((attrs||'module=""').match(/^\s*module=["'](.*)["']\s*$/)[1]);
          content.
            replace(/<doc:source(\s+[^>]*)?>([\s\S]*)<\/doc:source>/mi, function(_, attrs, content) {
              example.addSource('index.html', content.
                replace(/<script>([\s\S]*)<\/script>/mi, function(_, script) {
                  example.addSource('script.js', script);
                  return '';
                }).
                replace(/<style>([\s\S]*)<\/style>/mi, function(_, style) {
                  example.addSource('style.css', style);
                  return '';
                })
              );
            }).
            replace(/(<doc:scenario>)([\s\S]*)(<\/doc:scenario>)/mi, function(_, before, content){
              example.addSource('scenario.js', content);
            });

          return placeholder(example.toHtml());
        }).
        replace(/^<pre(.*?)>([\s\S]*?)<\/pre>/mi, function(_, attrs, content){
          return placeholder(
            '<pre'+attrs+' class="prettyprint linenums">' +
              content.replace(/</g, '&lt;').replace(/>/g, '&gt;') +
              '</pre>');
        }).
        replace(/<div([^>]*)><\/div>/, '<div$1>\n<\/div>').
        replace(/{@link\s+([^\s}]+)\s*([^}]*?)\s*}/g, function(_all, url, title){
          var isFullUrl = url.match(IS_URL),
            isAngular = url.match(IS_ANGULAR),
            isHash = url.match(IS_HASH),
            absUrl = isHash
              ? url
              : (isFullUrl ? url : self.convertUrlToAbsolute(url));

          if (!isFullUrl) self.links.push(absUrl);

          return '<a href="' + absUrl + '">' +
            (isAngular ? '<code>' : '') +
            (title || url).replace(/^#/g, '').replace(/\n/g, ' ') +
            (isAngular ? '</code>' : '') +
            '</a>';
      }).
      replace(/{@type\s+(\S+)(?:\s+(\S+))?}/g, function(_, type, url) {
        url = url || '#';
        return '<a href="' + url + '" class="' + self.prepare_type_hint_class_name(type) + '">' + type + '</a>';
      }).
      replace(/{@installModule\s+(\S+)?}/g, function(_, module) {
        return explainModuleInstallation(module);
      });

      if(self.options.highlightCodeFences) {
        parts[i] = parts[i].replace(/^```([+-]?)([a-z]*)([\s\S]*?)```/i, function(_, alert, type, content){
          var tClass = 'prettyprint linenums';

          // check if alert type is set - if true, add the corresponding
          // bootstrap classes
          if(alert) {
            tClass += ' alert alert-' + (alert === '+' ? 'success' : 'danger');
          }

          // if type is set, add lang-* information for google code
          // prettify - normally this is not necessary, because the prettifier
          // tries to guess the language.
          if(type) {
            tClass += ' lang-' + type;
          }

          return placeholder(
              '<pre class="' + tClass + '">' +
              content.replace(/</g, '&lt;').replace(/>/g, '&gt;') +
              '</pre>');
        });

      }
    });
    text = parts.join('');

    function prepareClassName(text) {
      return text.toLowerCase().replace(/[_\W]+/g, '-');
    };

    var pageClassName, suffix = '-page';
    if(this.name) {
      var split = this.name.match(/^\s*(.+?)\s*:\s*(.+)/);
      if(split && split.length > 1) {
        var before = prepareClassName(split[1]);
        var after = prepareClassName(split[2]);
        pageClassName = before + suffix + ' ' + before + '-' + after + suffix;
      }
    }
    pageClassName = pageClassName || prepareClassName(this.name || 'docs') + suffix;

    text = '<div class="' + pageClassName + '">' +
             marked(text) +
           '</div>';
    text = text.replace(/(?:<p>)?(REPLACEME\d+)(?:<\/p>)?/g, function(_, id) {
      return placeholderMap[id];
    });

    //!annotate CONTENT
    //!annotate="REGEX" CONTENT
    //!annotate="REGEX" TITLE|CONTENT
    text = text.replace(/\n?\/\/!annotate\s*(?:=\s*['"](.+?)['"])?\s+(.+?)\n\s*(.+?\n)/img,
      function(_, pattern, content, line) {
        var pattern = new RegExp(pattern || '.+');
        var title, text, split = content.split(/\|/);
        if(split.length > 1) {
          text = split[1];
          title = split[0];
        }
        else {
          title = 'Info';
          text = content;
        }
        return "\n" + line.replace(pattern, function(match) {
          return '<div class="nocode nocode-content" data-popover ' +
                   'data-content="' + text + '" ' +
                   'data-title="' + title + '">' +
                      match +
                 '</div>';
        });
      }
    );

    //!details /path/to/local/docs/file.html
    //!details="REGEX" /path/to/local/docs/file.html
    text = text.replace(/\/\/!details\s*(?:=\s*['"](.+?)['"])?\s+(.+?)\n\s*(.+?\n)/img,
      function(_, pattern, url, line) {
        url = '/notes/' + url;
        var pattern = new RegExp(pattern || '.+');
        return line.replace(pattern, function(match) {
          return '<div class="nocode nocode-content" data-foldout data-url="' + url + '">' + match + '</div>';
        });
      }
    );

    return text;
  },

  parse: function() {
    var atName;
    var atText;
    var match;
    var self = this;
    self.text.split(NEW_LINE).forEach(function(line){
      if ((match = line.match(/^\s*@(\w+)(\s+(.*))?/))) {
        // we found @name ...
        // if we have existing name
        flush();
        atName = match[1];
        atText = [];
        if(match[3]) atText.push(match[3].trimRight());
      } else {
        if (atName) {
          atText.push(line);
        }
      }
    });
    flush();
    if ( !this.name ){
      throw new Error('name does not exist for text \n\n' + self.text);
    }
    var shortName = this.name.split("#");
    if (shortName.length > 1) {
      this.shortName = shortName.pop().trim();
    } else {
      shortName = this.name.split(":");
      if (shortName.length > 1) {
        this.shortName = shortName.pop().trim();
      } else {
        this.shortName = this.name.split(".").pop().trim();
      }
    }

    this.id = this.id || // if we have an id just use it
      (this.ngdoc === 'error' ? this.name : '') ||
      (((this.file||'').match(/.*(\/|\\)([^(\/|\\)]*)\.ngdoc/)||{})[2]) || // try to extract it from file name
      this.name; // default to name
    this.description = this.markdown(this.description);
    this.example = this.markdown(this.example);
    this['this'] = this.markdown(this['this']);
    return this;

    function flush() {
      if (atName) {
        var text = trim(atText.join('\n')), match;
        if (atName == 'module') {
          match = text.match(/^\s*(\S+)\s*$/);
          if (match) {
            self.moduleName = match[1];
          }
        } else if (atName == 'param') {
          match = text.match(/^\{([^}]+)\}\s+(([^\s=]+)|\[(\S+)=([^\]]+)\])\s+(.*)/);
                             //  1      1    23       3   4   4 5      5  2   6  6
          if (!match) {
            throw new Error("Not a valid 'param' format: " + text + ' (found in: ' + self.file + ':' + self.line + ')');
          }

          var optional = (match[1].slice(-1) === '=');
          var param = {
            name: match[4] || match[3],
            description:self.markdown(text.replace(match[0], match[6])),
            type: optional ? match[1].substring(0, match[1].length-1) : match[1],
            optional: optional,
            default: match[5]
          };
          // if param name is a part of an object passed to a method
          // move it to a nested property of the parameter.
          var dotIdx = param.name.indexOf(".");
          if(dotIdx > 0){
            param.isProperty = true;
            var paramName = param.name.substr(0, dotIdx);
            var propertyName = param.name.substr(dotIdx + 1);
            param.name = propertyName;
            var p = self.param.filter(function(p) { return p.name === paramName; })[0];
            if (p) {
              p.properties = p.properties || [];
              p.properties.push(param);
            }
          } else {
            self.param.push(param);
          }
        } else if (atName == 'returns' || atName == 'return') {
          match = text.match(/^\{([^}]+)\}\s+(.*)/);
          if (!match) {
            throw new Error("Not a valid 'returns' format: " + text + ' (found in: ' + self.file + ':' + self.line + ')');
          }
          self.returns = {
            type: match[1],
            description: self.markdown(text.replace(match[0], match[2]))
          };
        } else if(atName == 'requires') {
          if (/^((({@link).+})|(\[.+\]({@link).+}))$/.test(text)) {
            self.requires.push({
              name: text,
              text: null
            });
          } else {
            match = text.match(/^([^\s]*)\s*([\S\s]*)/);
            self.requires.push({
              name: match[1],
              text: self.markdown(match[2])
            });
          }
        } else if(atName == 'property') {
          match = text.match(/^\{(\S+)\}\s+(\S+)(\s+(.*))?/);
          if (!match) {
            throw new Error("Not a valid 'property' format: " + text + ' (found in: ' + self.file + ':' + self.line + ')');
          }
          var property = new Doc({
            type: match[1],
            name: match[2],
            shortName: match[2],
            description: self.markdown(text.replace(match[0], match[4]))
          });
          self.properties.push(property);
        } else if(atName == 'eventType') {
          match = text.match(/^([^\s]*)\s+on\s+([\S\s]*)/);
          self.type = match[1];
          self.target = match[2];
        } else if(atName == 'constructor') {
          self.constructor = true;
        } else {
          self[atName] = text;
        }
      }
    }
  },

  html: function() {
    var dom = new DOM(),
      self = this,
      minerrMsg;

    if (this.options.editLink) {
      dom.tag('a', {
          href: self.options.editLink(self.file, self.line, self.codeline),
          class: 'improve-docs' }, function(dom) {
        dom.tag('i', {class:'icon-edit'}, ' ');
        dom.text('Improve this doc');
      });
    }

    if (this.options.sourceLink && this.options.isAPI) {
      dom.tag('a', {
          href: self.options.sourceLink(self.file, self.line, self.codeline),
          class: 'view-source' }, function(dom) {
        dom.tag('i', {class:'icon-eye-open'}, ' ');
        dom.text('View source');
      });
    }

    dom.h(title(this), function() {
      notice('deprecated', 'Deprecated API', self.deprecated);
      if (self.ngdoc === 'error') {
        minerrMsg = lookupMinerrMsg(self);
        dom.tag('pre', {
          class:'minerr-errmsg',
          'error-display': minerrMsg.replace(/"/g, '&quot;')
        }, minerrMsg);
      }
      if (self.ngdoc != 'overview') {
        dom.h('Description', self.description, dom.html);
      }
      dom.h('Dependencies', self.requires, function(require){
        dom.tag('code', function() {
          var id, name;
          if ((match = require.name.match(/^\[.+\](?={@link.+}$)/))) {
            id = require.name.substring(require.name.indexOf('{@link ') + 7, require.name.length-1);
            name = match[0].replace(/[\[\]]/g,'');
          } else if (require.name.match(/^{@link\s\w+\b.*}$/)) {
            var splitName = require.name.replace('|',' ').slice(0, -1).split(' ');
            splitName.shift();
            id = splitName.shift();
            if (splitName.length > 0) {
              name = splitName.join(' ');
            } else {
              name = id.split(/[\.:\/]/).pop();
            }
          } else {
            id = require.name[0] == '$' ? 'ng.' + require.name : require.name
            name = require.name.split(/[\.:\/]/).pop();
          }
          dom.tag('a', {href: self.convertUrlToAbsolute(id)}, name);
        });
        dom.html(require.text);
      });

      (self['html_usage_' + self.ngdoc] || function() {
        throw new Error("Don't know how to format @ngdoc: " + self.ngdoc);
      }).call(self, dom);

      dom.h('Example', self.example, dom.html);
    });

    self.anchors = dom.anchors;

    return dom.toString();

    //////////////////////////

    function notice(name, legend, msg){
      if (self[name] === undefined) return;
      dom.tag('fieldset', {'class':name}, function(dom){
        dom.tag('legend', legend);
        dom.text(msg);
      });
    }

  },

  prepare_type_hint_class_name : function(type) {
    var typeClass = type.toLowerCase().match(/^[-\w]+/) || [];
    typeClass = typeClass[0] ? typeClass[0] : 'object';
    return 'label type-hint type-hint-' + typeClass;
  },

  html_usage_parameters: function(dom) {
    var self = this;
    var params = this.param ? this.param : [];
    if(this.animations) {
      dom.h('Animations', this.animations, function(animations){
        dom.html('<ul>');
        var animations = animations.split("\n");
        animations.forEach(function(ani) {
          dom.html('<li>');
          dom.text(ani);
          dom.html('</li>');
        });
        dom.html('</ul>');
      });
      // dom.html('<a href="api/ngAnimate.$animate">Click here</a> to learn more about the steps involved in the animation.');
    }
    if(params.length > 0) {
      dom.html('<h2>Parameters</h2>');
      dom.html('<table class="variables-matrix table table-bordered table-striped">');
      dom.html('<thead>');
      dom.html('<tr>');
      dom.html('<th>Param</th>');
      dom.html('<th>Type</th>');
      dom.html('<th>Details</th>');
      dom.html('</tr>');
      dom.html('</thead>');
      dom.html('<tbody>');
      processParams(params);
      function processParams(params) {
        for(var i=0;i<params.length;i++) {
          param = params[i];
          var name = param.name;
          var types = param.type;
          if(types[0]=='(') {
            types = types.substr(1);
          }

          var limit = types.length - 1;
          if(types.charAt(limit) == ')' && types.charAt(limit-1) != '(') {
            types = types.substr(0,limit);
          }
          types = types.split(/\|(?![\(\)\w\|\s]+>)/);
          if (param.optional) {
            name += ' <div><em>(optional)</em></div>';
          }
          dom.html('<tr>');
          dom.html('<td>' + name + '</td>');
          dom.html('<td>');
          for(var j=0;j<types.length;j++) {
            var type = types[j];
            dom.html('<a href="" class="' + self.prepare_type_hint_class_name(type) + '">');
            dom.text(type);
            dom.html('</a>');
          }

          dom.html('</td>');
          dom.html('<td>');
          dom.html(param.description);
          if (param.default) {
            dom.html(' <p><em>(default: ' + param.default + ')</em></p>');
          }
          if (param.properties) {
//            dom.html('<table class="variables-matrix table table-bordered table-striped">');
            dom.html('<table>');
            dom.html('<thead>');
            dom.html('<tr>');
            dom.html('<th>Property</th>');
            dom.html('<th>Type</th>');
            dom.html('<th>Details</th>');
            dom.html('</tr>');
            dom.html('</thead>');
            dom.html('<tbody>');
            processParams(param.properties);
            dom.html('</tbody>');
            dom.html('</table>');
          }
          dom.html('</td>');
          dom.html('</tr>');
        };
      }
      dom.html('</tbody>');
      dom.html('</table>');
    }
  },

  html_usage_bindings: function(dom) {
    var self = this;
    var params = this.param ? this.param : [];
    if(this.animations) {
      dom.h('Animations', this.animations, function(animations){
        dom.html('<ul>');
        var animations = animations.split("\n");
        animations.forEach(function(ani) {
          dom.html('<li>');
          dom.text(ani);
          dom.html('</li>');
        });
        dom.html('</ul>');
      });
      // dom.html('<a href="api/ngAnimate.$animate">Click here</a> to learn more about the steps involved in the animation.');
    }
    if(params.length > 0) {
      dom.html('<h2>Bindings</h2>');
      dom.html('<table class="variables-matrix table table-bordered table-striped">');
      dom.html('<thead>');
      dom.html('<tr>');
      dom.html('<th>Binding</th>');
      dom.html('<th>Type</th>');
      dom.html('<th>Details</th>');
      dom.html('</tr>');
      dom.html('</thead>');
      dom.html('<tbody>');
      processParams(params);
      function processParams(params) {
        for(var i=0;i<params.length;i++) {
          param = params[i];
          var name = param.name;
          var types = param.type;
          if(types[0]=='(') {
            types = types.substr(1);
          }

          var limit = types.length - 1;
          if(types.charAt(limit) == ')' && types.charAt(limit-1) != '(') {
            types = types.substr(0,limit);
          }
          types = types.split(/\|(?![\(\)\w\|\s]+>)/);
          if (param.optional) {
            name += ' <div><em>(optional)</em></div>';
          }
          dom.html('<tr>');
          dom.html('<td>' + name + '</td>');
          dom.html('<td>');
          for(var j=0;j<types.length;j++) {
            var type = types[j];
            dom.html('<a href="" class="' + self.prepare_type_hint_class_name(type) + '">');
            dom.text(type);
            dom.html('</a>');
          }

          dom.html('</td>');
          dom.html('<td>');
          dom.html(param.description);
          if (param.default) {
            dom.html(' <p><em>(default: ' + param.default + ')</em></p>');
          }
          if (param.properties) {
            //            dom.html('<table class="variables-matrix table table-bordered table-striped">');
            dom.html('<table>');
            dom.html('<thead>');
            dom.html('<tr>');
            dom.html('<th>Property</th>');
            dom.html('<th>Type</th>');
            dom.html('<th>Details</th>');
            dom.html('</tr>');
            dom.html('</thead>');
            dom.html('<tbody>');
            processParams(param.properties);
            dom.html('</tbody>');
            dom.html('</table>');
          }
          dom.html('</td>');
          dom.html('</tr>');
        };
      }
      dom.html('</tbody>');
      dom.html('</table>');
    }
  },

  html_usage_returns: function(dom) {
    var self = this;
    if (self.returns) {
      dom.html('<h2>Returns</h2>');
      dom.html('<table class="variables-matrix">');
      dom.html('<tr>');
      dom.html('<td>');
      dom.html('<a href="" class="' + self.prepare_type_hint_class_name(self.returns.type) + '">');
      dom.text(self.returns.type);
      dom.html('</a>');
      dom.html('</td>');
      dom.html('<td>');
      dom.html(self.returns.description);
      dom.html('</td>');
      dom.html('</tr>');
      dom.html('</table>');
    }
  },

  html_usage_this: function(dom) {
    var self = this;
    if (self['this']) {
      dom.h(function(dom){
        dom.html("Method's <code>this</code>");
      }, function(dom){
        dom.html(self['this']);
      });
    }
  },

  html_usage_function: function(dom){
    var self = this;
    var name = self.name.match(/^angular(\.mock)?\.(\w+)$/) ? self.name : self.name.split(/\./).pop()

    dom.h('Usage', function() {
      dom.code(function() {
        if (self.constructor) {
          dom.text('new ');
        }
        dom.text(name.split(':').pop());
        dom.text('(');
        self.parameters(dom, ', ');
        dom.text(');');
      });

      self.html_usage_parameters(dom);
      self.html_usage_this(dom);
      self.html_usage_returns(dom);
    });
    this.method_properties_events(dom);
  },

  html_usage_property: function(dom){
    var self = this;
    dom.h('Usage', function() {
      dom.code(function() {
        dom.text(self.name.split(':').pop());
      });

      self.html_usage_returns(dom);
    });
  },

  html_usage_directive: function(dom){
    var self = this;
    dom.h('Usage', function() {
      var restrict = self.restrict || 'A';

      /*
      if (restrict.match(/E/)) {
        dom.html('<p>');
        dom.text('This directive can be used as custom element, but be aware of ');
        dom.tag('a', {href:'guide/ie'}, 'IE restrictions');
        dom.text('.');
        dom.html('</p>');
      }
      */

      if (self.usage) {
        dom.code(function() {
          dom.text(self.usage);
        });
      } else {
        if (restrict.match(/E/)) {
          dom.text('as element:');
          dom.code(function() {
            dom.text('<');
            dom.text(dashCase(self.shortName));
            renderParams('\n       ', '="', '"');
            dom.text('>\n</');
            dom.text(dashCase(self.shortName));
            dom.text('>');
          });
        }
        if (restrict.match(/A/)) {
          var element = self.element || 'ANY';
          dom.text('as attribute');
          dom.code(function() {
            dom.text('<' + element + ' ');
            dom.text(dashCase(self.shortName));
            renderParams('\n     ', '="', '"', true);
            dom.text('>\n   ...\n');
            dom.text('</' + element + '>');
          });
        }
        if (restrict.match(/C/)) {
          dom.text('as class');
          var element = self.element || 'ANY';
          dom.code(function() {
            dom.text('<' + element + ' class="');
            dom.text(dashCase(self.shortName));
            renderParams(' ', ': ', ';', true);
            dom.text('">\n   ...\n');
            dom.text('</' + element + '>');
          });
        }
      }
      self.html_usage_directiveInfo(dom);
      self.html_usage_parameters(dom);
    });

    self.method_properties_events(dom);

    function renderParams(prefix, infix, suffix, skipSelf) {
      (self.param||[]).forEach(function(param) {
        var skip = skipSelf && (param.name == self.shortName || param.name.indexOf(self.shortName + '|') == 0);
        if (!skip) {
          dom.text(prefix);
          dom.text(param.optional ? '[' : '');
          var parts = param.name.split('|');
          dom.text(dashCase(parts[skipSelf ? 0 : 1] || parts[0]));
        }
        if (BOOLEAN_ATTR[param.name]) {
          dom.text(param.optional ? ']' : '');
        } else {
          dom.text(BOOLEAN_ATTR[param.name] ? '' : infix );
          dom.text(('{' + param.type + '}').replace(/^\{\'(.*)\'\}$/, '$1'));
          dom.text(suffix);
          dom.text(param.optional && !skip ? ']' : '');
        }
      });
    }

  },

  html_usage_component: function(dom){
    //this.html_usage_interface(dom)
    var self = this;
    dom.h('Usage', function() {
      dom.code(function() {
        dom.text('<');
        dom.text(dashCase(self.shortName));

        renderParams('\n       ', '="', '"');
        dom.text('>\n</');
        dom.text(dashCase(self.shortName));
        dom.text('>');
      });
      self.html_usage_componentInfo(dom);
      self.html_usage_bindings(dom);
    });

    self.method_properties_events(dom);

    function renderParams(prefix, infix, suffix, skipSelf) {
      (self.param||[]).forEach(function(param) {
        var skip = skipSelf && (param.name == self.shortName || param.name.indexOf(self.shortName + '|') == 0);
        if (!skip) {
          dom.text(prefix);
          dom.text(param.optional ? '[' : '');
          var parts = param.name.split('|');
          dom.text(dashCase(parts[skipSelf ? 0 : 1] || parts[0]));
        }
        if (BOOLEAN_ATTR[param.name]) {
          dom.text(param.optional ? ']' : '');
        } else {
          dom.text(BOOLEAN_ATTR[param.name] ? '' : infix );
          dom.text(('{' + param.type + '}').replace(/^\{\'(.*)\'\}$/, '$1'));
          dom.text(suffix);
          dom.text(param.optional && !skip ? ']' : '');
        }
      });
    }
  },

  html_usage_filter: function(dom){
    var self = this;
    dom.h('Usage', function() {
      dom.h('In HTML Template Binding', function() {
        dom.tag('code', function() {
          if (self.usage) {
            dom.text(self.usage);
          } else {
            dom.text('{{ ');
            dom.text(self.shortName);
            dom.text('_expression | ');
            dom.text(self.shortName);
            self.parameters(dom, ':', true);
            dom.text(' }}');
          }
        });
      });

      dom.h('In JavaScript', function() {
        dom.tag('code', function() {
          dom.text('$filter(\'');
          dom.text(self.shortName);
          dom.text('\')(');
          self.parameters(dom, ', ');
          dom.text(')');
        });
      });

      self.html_usage_parameters(dom);
      self.html_usage_this(dom);
      self.html_usage_returns(dom);
    });
  },

  html_usage_inputType: function(dom){
    var self = this;
    dom.h('Usage', function() {
      dom.code(function() {
        dom.text('<input type="' + self.shortName + '"');
        (self.param||[]).forEach(function(param){
          dom.text('\n      ');
          dom.text(param.optional ? ' [' : ' ');
          dom.text(dashCase(param.name));
          dom.text(BOOLEAN_ATTR[param.name] ? '' : '="{' + param.type + '}"');
          dom.text(param.optional ? ']' : '');
        });
        dom.text('>');
      });
      self.html_usage_parameters(dom);
    });
  },

  html_usage_directiveInfo: function(dom) {
    var self = this;
    var list = [];


    if (self.scope !== undefined) {
      list.push('This directive creates new scope.');
    }
    if (self.priority !== undefined) {
      list.push('This directive executes at priority level ' + self.priority + '.');
    }

    if (list.length) {
      dom.h('Directive info', function() {
        dom.ul(list);
      });
    }
  },

  html_usage_componentInfo: function(dom) {
    var self = this;
    var list = [];


    if (self.bindings !== undefined) {
      list.push('This component uses:');
    }

    if (list.length) {
      dom.h('Component info', function() {
        dom.ul(list);
      });
    }
  },

  html_usage_overview: function(dom){
    dom.html(this.description);
  },

  html_usage_error: function (dom) {
    dom.html();
  },

  html_usage_interface: function(dom){
    var self = this;

    if (this.param.length) {
      dom.h('Usage', function() {
        dom.code(function() {
          dom.text(self.name.split('.').pop().split(':').pop());
          dom.text('(');
          self.parameters(dom, ', ');
          dom.text(');');
        });

        self.html_usage_parameters(dom);
        self.html_usage_this(dom);
        self.html_usage_returns(dom);
      });
    }
    this.method_properties_events(dom);
  },

  html_usage_service: function(dom) {
    this.html_usage_interface(dom)
  },

  html_usage_object: function(dom) {
    this.html_usage_interface(dom)
  },

  html_usage_controller: function(dom) {
    this.html_usage_interface(dom)
  },


  method_properties_events: function(dom) {
    var self = this;
    if (self.methods.length) {
      dom.div({class:'member method'}, function(){
        dom.h('Methods', self.methods, function(method){
          if (self.options.sourceLink) {
            dom.tag('a', {
              href: self.options.sourceLink(method.file, method.line, method.codeline),
              class: 'view-source icon-eye-open'
            }, ' ');
          }
          //filters out .IsProperty parameters from the method signature
          var signature = (method.param || []).filter(function(e) { return e.isProperty !== true; }).map(property('name'));
          dom.h(method.shortName + '(' + signature.join(', ') + ')', method, function() {
            dom.html(method.description);
            method.html_usage_parameters(dom);
            self.html_usage_this(dom);
            method.html_usage_returns(dom);

            dom.h('Example', method.example, dom.html);
          });
        });
      });
    }
    if (self.properties.length) {
      dom.div({class:'member property'}, function(){
        dom.h('Properties', self.properties, function(property){
          dom.h(property.shortName, function() {
            dom.html(property.description);
            if (!property.html_usage_returns) {
              console.log(property);
            }
            property.html_usage_returns(dom);
            dom.h('Example', property.example, dom.html);
          });
        });
      });
    }
    if (self.events.length) {
      dom.div({class:'member event'}, function(){
        dom.h('Events', self.events, function(event){
          dom.h(event.shortName, event, function() {
            dom.html(event.description);
            if (event.type == 'listen') {
              dom.tag('div', {class:'inline'}, function() {
                dom.h('Listen on:', event.target);
              });
            } else {
              dom.tag('div', {class:'inline'}, function() {
                dom.h('Type:', event.type);
              });
              dom.tag('div', {class:'inline'}, function() {
                dom.h('Target:', event.target);
              });
            }
            event.html_usage_parameters(dom);
            self.html_usage_this(dom);

            dom.h('Example', event.example, dom.html);
          });
        });
      });
    }
  },

  parameters: function(dom, separator, skipFirst, prefix) {
    var sep = prefix ? separator : '';
    (this.param||[]).forEach(function(param, i){
      if (!(skipFirst && i==0)) {
        if (param.isProperty) { return; }
        if (param.optional) {
          dom.text('[' + sep + param.name + ']');
        } else {
          dom.text(sep + param.name);
        }
      }
      sep = separator;
    });
  }

};
//////////////////////////////////////////////////////////


//////////////////////////////////////////////////////////
var GLOBALS = /^angular\.([^\.]+)$/,
    MODULE = /^([^\.]+)$/,
    MODULE_MOCK = /^angular\.mock\.([^\.]+)$/,
    MODULE_CONTROLLER = /^(.+)\.controllers?:([^\.]+)$/,
    MODULE_COMPONENT = /^(.+)\.components?:([^\.]+)$/,
    MODULE_DIRECTIVE = /^(.+)\.directives?:([^\.]+)$/,
    MODULE_DIRECTIVE_INPUT = /^(.+)\.directives?:input\.([^\.]+)$/,
    MODULE_CUSTOM = /^(.+)\.([^\.]+):([^\.]+)$/,
    MODULE_SERVICE = /^(.+)\.([^\.]+?)(Provider)?$/,
    MODULE_TYPE = /^([^\.]+)\..+\.([A-Z][^\.]+)$/;


function title(doc) {
  if (!doc.name) return doc.name;
  var match,
      module = doc.moduleName,
      overview = doc.ngdoc == 'overview',
      text = doc.name;

  var makeTitle = function (name, type, componentType, component) {
    if (!module) {
      module = component;
      if (module == 'angular') {
          module = 'ng';
      }
      doc.moduleName = module;
    }
    // Makes title markup.
    // makeTitle('Foo', 'directive', 'module', 'ng') ->
    //    Foo is a directive in module ng
    return function () {
      this.tag('code', name);
      this.tag('div', function () {
        this.tag('span', {class: 'hint'}, function () {
          if (type && component) {
            this.text(type + ' in ' + componentType + ' ');
            this.tag('code', component);
          }
        });
      });
    };
  };

  if (doc.ngdoc === 'error') {
    return makeTitle(doc.fullName, 'error', 'component', doc.getMinerrNamespace());
  } else if (text == 'angular.Module') {
    return makeTitle('Module', 'Type', 'module', 'ng');
  } else if (match = text.match(GLOBALS)) {
    return makeTitle('angular.' + match[1], 'API', 'module', 'ng');
  } else if (match = text.match(MODULE)) {
    return makeTitle(overview ? '' : match[1], '', 'module', match[1]);
  } else if (match = text.match(MODULE_MOCK)) {
    return makeTitle('angular.mock.' + match[1], 'API', 'module', 'ng');
  } else if (match = text.match(MODULE_CONTROLLER) && doc.type === 'controller') {
    return makeTitle(match[2], 'controller', 'module', match[1]);
  } else if (match = text.match(MODULE_COMPONENT)) {
    return makeTitle(match[2], 'component', 'module', match[1]);
  } else if (match = text.match(MODULE_DIRECTIVE)) {
    return makeTitle(match[2], 'directive', 'module', match[1]);
  } else if (match = text.match(MODULE_DIRECTIVE_INPUT)) {
    return makeTitle('input [' + match[2] + ']', 'directive', 'module', match[1]);
  } else if (match = text.match(MODULE_CUSTOM)) {
    return makeTitle(match[3], doc.ngdoc || match[2], 'module', match[1]);
  } else if (match = text.match(MODULE_TYPE) && doc.ngdoc === 'type') {
    return makeTitle(match[2], 'type', 'module', module || match[1]);
  } else if (match = text.match(MODULE_SERVICE)) {
    if (overview) {
      // module name with dots looks like a service
      return makeTitle('', '', 'module', text);
    }
    return makeTitle(match[2] + (match[3] || ''), 'service', 'module', module || match[1]);
  }
  return text;
}


function scenarios(docs, urlPrefix){
  var specs = [];

  specs.push('describe("ui-grid", function() {');
  appendSpecs(urlPrefix);
  specs.push('});');

  // specs.push('');
  // specs.push('');

  // specs.push('describe("angular+jquery", function() {');
  // appendSpecs('index-jq-nocache.html#!/');
  // specs.push('});');

  return specs.join('\n');

  function appendSpecs(urlPrefix) {
    docs.forEach(function(doc){
      specs.push('  describe("' + doc.section + '/' + doc.id + '", function() {');
      specs.push('    beforeEach(function() {');
      specs.push('      browser.driver.get("' + urlPrefix + doc.section + '/' + doc.id + '");');
      specs.push('    });');
      specs.push('  ');
      doc.scenarios.forEach(function(scenario){
        specs.push(indentCode(trim(scenario), 4));
        specs.push('');
      });
      specs.push('});');
      specs.push('');
    });
  }
}


//////////////////////////////////////////////////////////
function metadata(docs) {
  var pages = [];
  docs.forEach(function(doc){
    var path = (doc.name || '').split(/(\:\s*)/);
    for ( var i = 1; i < path.length; i++) {
      path.splice(i, 1);
    }
    var shortName = path.pop().trim();

    if (path.pop() == 'input') {
      shortName = 'input [' + shortName + ']';
    }

    doc.isDeprecated = false;
    if (doc.deprecated !== undefined) {
      doc.isDeprecated = true;
    }

    pages.push({
      section: doc.section,
      id: doc.id,
      name: title(doc),
      shortName: shortName,
      type: doc.ngdoc,
      moduleName: doc.moduleName,
      shortDescription: doc.shortDescription(),
      keywords: doc.keywords(),
      isDeprecated: doc.isDeprecated
    });
  });
  pages.sort(sidebarSort);
  return pages;
}

var KEYWORD_PRIORITY = {
  '.index': 1,
  '.overview': 1,
  '.bootstrap': 2,
  '.mvc': 3,
  '.scopes': 4,
  '.compiler': 5,
  '.templates': 6,
  '.services': 7,
  '.di': 8,
  '.unit-testing': 9,
  '.dev_guide': 9,
  '.dev_guide.overview': 1,
  '.dev_guide.bootstrap': 2,
  '.dev_guide.bootstrap.auto_bootstrap': 1,
  '.dev_guide.bootstrap.manual_bootstrap': 2,
  '.dev_guide.mvc': 3,
  '.dev_guide.mvc.understanding_model': 1,
  '.dev_guide.mvc.understanding_controller': 2,
  '.dev_guide.mvc.understanding_view': 3,
  '.dev_guide.scopes': 4,
  '.dev_guide.scopes.understanding_scopes': 1,
  '.dev_guide.scopes.internals': 2,
  '.dev_guide.compiler': 5,
  '.dev_guide.templates': 6,
  '.dev_guide.services': 7,
  '.dev_guide.di': 8,
  '.dev_guide.unit-testing': 9
};

var GUIDE_PRIORITY = [
  'introduction',
  'overview',
  'concepts',
  'dev_guide.mvc',

  'dev_guide.mvc.understanding_controller',
  'dev_guide.mvc.understanding_model',
  'dev_guide.mvc.understanding_view',

  'dev_guide.services.understanding_services',
  'dev_guide.services.managing_dependencies',
  'dev_guide.services.creating_services',
  'dev_guide.services.injecting_controllers',
  'dev_guide.services.testing_services',
  'dev_guide.services.$location',
  'dev_guide.services',

  'databinding',
  'dev_guide.templates.css-styling',
  'dev_guide.templates.filters.creating_filters',
  'dev_guide.templates.filters',
  'dev_guide.templates.filters.using_filters',
  'dev_guide.templates',

  'di',
  'providers',
  'module',
  'scope',
  'expression',
  'bootstrap',
  'directive',
  'compiler',

  'forms',
  'animations',

  'dev_guide.e2e-testing',
  'dev_guide.unit-testing',

  'i18n',
  'ie',
  'migration'
];

function sidebarSort(a, b){
  priorityA = GUIDE_PRIORITY.indexOf(a.id);
  priorityB = GUIDE_PRIORITY.indexOf(b.id);

  if (priorityA > -1 || priorityB > -1) {
    return priorityA < priorityB ? -1 : (priorityA > priorityB ? 1 : 0);
  }

  function mangleName(doc) {
    var path = doc.id.split(/\./);
    var mangled = [];
    var partialName = '';
    path.forEach(function(name){
      partialName += '.' + name;
      mangled.push(KEYWORD_PRIORITY[partialName] || 5);
      mangled.push(name);
    });
    return (doc.section + '/' + mangled.join('.')).toLowerCase();
  }
  var nameA = mangleName(a);
  var nameB = mangleName(b);
  return nameA < nameB ? -1 : (nameA > nameB ? 1 : 0);
}


//////////////////////////////////////////////////////////
function trim(text) {
  var MAX_INDENT = 9999;
  var empty = RegExp.prototype.test.bind(/^\s*$/);
  var lines = text.split('\n');
  var minIndent = MAX_INDENT;
  var indentRegExp;
  var ignoreLine = (lines[0][0] != ' '  && lines.length > 1);
  // ignore first line if it has no indentation and there is more than one line

  lines.forEach(function(line){
    if (ignoreLine) {
      ignoreLine = false;
      return;
    }

    var indent = line.match(/^\s*/)[0].length;
    if (indent > 0 || minIndent == MAX_INDENT) {
      minIndent = Math.min(minIndent, indent);
    }
  });

  indentRegExp = new RegExp('^\\s{0,' + minIndent + '}');

  for ( var i = 0; i < lines.length; i++) {
    lines[i] = lines[i].replace(indentRegExp, '');
  }

  // remove leading lines
  while (empty(lines[0])) {
    lines.shift();
  }

  // remove trailing
  while (empty(lines[lines.length - 1])) {
    lines.pop();
  }
  return lines.join('\n');
}

function indentCode(text, spaceCount) {
  var lines = text.split('\n'),
    indent = '',
    fixedLines = [];

  while(spaceCount--) indent += ' ';

  lines.forEach(function(line) {
    fixedLines.push(indent + line);
  });

  return fixedLines.join('\n');
}

//////////////////////////////////////////////////////////
function merge(docs){
  var byFullId = {};

  docs.forEach(function(doc) {
    byFullId[doc.section + '/' + doc.id] = doc;
  });

  for(var i = 0; i < docs.length;) {
    if (findParent(docs[i], 'method') || findParent(docs[i], 'property') || findParent(docs[i], 'event')) {
      docs.splice(i, 1);
    } else {
      i++;
    }
  }

  function findParent(doc, name) {
    var parentName = doc[name + 'Of'];
    if (!parentName) return false;

    var parent = byFullId[doc.section + '/' + parentName];
    if (!parent)
      throw new Error("No parent named '" + parentName + "' for '" +
        doc.name + "' in @" + name + "Of.");

    var listName = (name + 's').replace(/ys$/, 'ies');
    var list = parent[listName] = (parent[listName] || []);
    list.push(doc);
    list.sort(orderByName);
    return true;
  }

  function orderByName(a, b){
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  }
}
//////////////////////////////////////////////////////////


function checkBrokenLinks(docs, apis, options) {
  var byFullId = Object.create(null);

  docs.forEach(function(doc) {
    byFullId[doc.section + '/' + doc.id] = doc;
    if (apis[doc.section]) {
      doc.anchors.push('directive', 'service', 'filter', 'function');
    }
  });

  docs.forEach(function(doc) {
    doc.links.forEach(function(link) {
      if (options && !options.html5mode) {
        link = link.substring(2);
      }
      // convert #id to path#id
      if (link[0] == '#') {
        link = doc.section + '/' + doc.id.split('#').shift() + link;
      }

      var parts = link.split('#');
      var pageLink = parts[0];
      var anchorLink = parts[1];
      var linkedPage = byFullId[pageLink];

      if (!linkedPage) {
        console.log('WARNING: ' + doc.section + '/' + doc.id + ' (defined in ' + doc.file + ') points to a non existing page "' + link + '"!');
      } else if (anchorLink && linkedPage.anchors.indexOf(anchorLink) === -1) {
        console.log('WARNING: ' + doc.section + '/' + doc.id + ' (defined in ' + doc.file + ') points to a non existing anchor "' + link + '"!');
      }
    });
  });
}


function property(name) {
  return function(value){
    return value[name];
  };
}


var DASH_CASE_REGEXP = /[A-Z]/g;
function dashCase(name){
  return name.replace(DASH_CASE_REGEXP, function(letter, pos) {
    return (pos ? '-' : '') + letter.toLowerCase();
  });
}
//////////////////////////////////////////////////////////

function explainModuleInstallation(moduleName){
  var ngMod = ngModule(moduleName),
    modulePackage = 'angular-' + moduleName,
    modulePackageFile = modulePackage + '.js';

  return '<h1>Installation</h1>' +
    '<p>First include <code>' + modulePackageFile +'</code> in your HTML:</p><pre><code>' +
    '    &lt;script src=&quot;angular.js&quot;&gt;\n' +
    '    &lt;script src=&quot;' + modulePackageFile + '&quot;&gt;</pre></code>' +

    '<p>You can download this file from the following places:</p>' +
    '<ul>' +
      '<li>[Google CDN](https://developers.google.com/speed/libraries/devguide#angularjs)<br>' +
        'e.g. <code>"//ajax.googleapis.com/ajax/libs/angularjs/X.Y.Z/' + modulePackageFile + '"</code></li>' +
      '<li>[Bower](http://bower.io)<br>' +
       'e.g. <code>bower install ' + modulePackage + '@X.Y.Z</code></li>' +
      '<li><a href="http://code.angularjs.org/">code.angularjs.org</a><br>' +
        'e.g. <code>"//code.angularjs.org/X.Y.Z/' + modulePackageFile + '"</code></li>' +
    '</ul>' +
    '<p>where X.Y.Z is the AngularJS version you are running.</p>' +
    '<p>Then load the module in your application by adding it as a dependent module:</p><pre><code>' +
    '    angular.module(\'app\', [\'' + ngMod + '\']);</pre></code>' +

    '<p>With that you\'re ready to get started!</p>';
}

function ngModule(moduleName) {
  return 'ng' + moduleName[0].toUpperCase() + moduleName.substr(1);
}
