/*global module:false*/
module.exports = function (grunt) {
  grunt.loadTasks('./tasks/');
  grunt.loadNpmTasks('grunt-conventional-changelog');
  grunt.loadNpmTasks('grunt-contrib-connect');
  grunt.loadNpmTasks('grunt-contrib-clean');
  grunt.loadNpmTasks('grunt-contrib-watch');
  grunt.loadNpmTasks('grunt-jasmine-node');

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    conventionalChangelog: {
      options: {changelogOpts: {preset: 'angular'}},
      release: {src: 'CHANGELOG.md'}
    },
    connect: {
      options: {
        base: 'docs',
        keepalive: true
      },
      server: {}
    },
    clean: ['.tmp', 'docs'],
    jasmine_node: {
      options: {
        forceExit: true,
        match: '.',
        matchall: false,
        extensions: 'js',
        specNameMatcher: 'spec'
      },
      all: ['spec/']
    },
    'uidocs-generator': {
      options: {
        title: 'grunt-uidocs-example',
        html5Mode: false
      },
      examples: {
        src: ['examples/*.uidoc', 'examples/*.ngdoc'],
        title: 'Example Custom Docs'
      },
      api: ['src/**/*.js']
    },
    watch: {
      parser: {
        files: ['src/*.js', 'spec/*Spec.js'],
        tasks: ['jasmine_node']
      }
    }
  });

  grunt.registerTask('test', 'Run tests for parser code', ['jasmine_node']);
};
