"use strict";

const fs = require("fs-extra");
const path = require("path");
const uglifyes = require("uglify-es");
const cleancss = require("clean-css");
const htmlminifier = require("html-minifier");

const SOURCE = path.join(__dirname, "src");
const SOURCE_STATIC = path.join(SOURCE, "static");
const BUILD = path.join(__dirname, "build");
const BUILD_STATIC = path.join(BUILD, "static");

const concat_static_source_files_of_type = async (ext) =>
  fs.readdir(SOURCE_STATIC)
    .then(files => files.filter(f => new RegExp(`\\.${ext}$`, "i").test(f)))
    .then(files => Promise.all(files.map(f => fs.readFile(path.join(SOURCE_STATIC, f), "utf8"))))
    .then(files => files.reduce((js, f) => js + f, ""));

const minify_html = html => htmlminifier.minify(html, {
  collapseBooleanAttributes: true,
  collapseInlineTagWhitespace: true,
  collapseWhitespace: true,
  decodeEntities: true,
  ignoreCustomFragments: [/{{{?[^{}]+}}}?/],
  includeAutoGeneratedTags: true,
  keepClosingSlash: false,
  minifyCSS: false,
  minifyJS: false,
  minifyURLs: false,
  preserveLineBreaks: false,
  preventAttributesEscaping: false,
  processConditionalComments: false,
  removeAttributeQuotes: true,
  removeComments: true,
  removeEmptyAttributes: false,
  removeEmptyElements: false,
  removeOptionalTags: true,
  removeRedundantAttributes: true,
  removeScriptTypeAttributes: true,
  removeStyleLinkTypeAttributes: true,
  removeTagWhitespace: true,
  sortAttributes: true,
  sortClassName: true,
  useShortDoctype: true,
});

const minify_js = js => uglifyes.minify(js, {
  mangle: true,
  compress: {
    booleans: true,
    collapse_vars: true,
    comparisons: true,
    conditionals: true,
    dead_code: true,
    drop_console: true,
    drop_debugger: true,
    evaluate: true,
    hoist_funs: true,
    hoist_vars: false,
    if_return: true,
    join_vars: true,
    keep_fargs: false,
    keep_fnames: false,
    loops: true,
    negate_iife: true,
    properties: true,
    reduce_vars: true,
    sequences: true,
    unsafe: true,
    unused: true,
  },
}).code;

const minify_css = css => new cleancss({
  returnPromise: true,
}).minify(css)
  .then(({styles}) => styles);

fs.ensureDir(BUILD_STATIC)
  .then(() => Promise.all([
    concat_static_source_files_of_type("js")
      .then(minify_js)
      .then(js => fs.writeFile(path.join(BUILD_STATIC, "script.js"), js)),
    concat_static_source_files_of_type("css")
      .then(minify_css)
      .then(css => fs.writeFile(path.join(BUILD_STATIC, "style.css"), css)),
    fs.readFile(path.join(SOURCE, "page.hbs"), "utf8")
      .then(minify_html)
      .then(html => fs.writeFile(path.join(BUILD, "page.hbs"), html)),
  ]));