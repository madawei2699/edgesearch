"use strict";

const fs = require("fs-extra");
const path = require("path");
const https = require("https");
const express = require("express");
const moment = require("moment");
const handlebars = require("handlebars");
const redis = require("redis");
const minimist = require("minimist");
const {promisify} = require("util");
const compression = require("compression");

const ARGS = minimist(process.argv.slice(2));
const FIELDS = ["title", "location"];
const MODES = ["require", "contain", "exclude"];
const JOBS = fs.readJSONSync(path.join(__dirname, "data-processed.json"));
const MAX_RESULTS = 200;

const db = redis.createClient();
const db_job_words_key = (job, field) => `${job.ID}_${field}_words`;
const db_cmd = promisify(db.send_command).bind(db);
const server = express();
server.use(compression({
  level: 9,
  memLevel: 9,
}));

let Page;

if (ARGS.hot) {
  console.log(`Hot reloading mode`);
  const PAGE_TEMPLATE_PATH = path.join(__dirname, "page.hbs");
  const PAGE_RESOURCES_TEMPLATE_PATH = path.join(__dirname, "page.resources.hbs");
  const compiler = () => {
    const compiled = handlebars.compile(fs.readFileSync(PAGE_TEMPLATE_PATH, "utf8"));
    let compiled_resources = handlebars.compile(fs.readFileSync(PAGE_RESOURCES_TEMPLATE_PATH, "utf8"));
    Page = ctx => compiled({
      ...ctx,
      externalResources: compiled_resources,
    });
    console.log(moment().format("dddd, MMMM Do YYYY, HH:mm:ss"), "Loaded");
  };
  compiler();
  fs.watchFile(PAGE_TEMPLATE_PATH, compiler);
  fs.watchFile(PAGE_RESOURCES_TEMPLATE_PATH, compiler);
  server.use("/static", express.static(path.join(__dirname, "static"), {
    dotfiles: "allow",
    extensions: false,
    fallthrough: false,
    index: false,
    redirect: false,
  }));
} else {
  Page = handlebars.compile(fs.readFileSync(path.join(__dirname, "build.hbs"), "utf8"));
  server.use("/static", express.static(path.join(__dirname, "build_static"), {
    dotfiles: "allow",
    extensions: false,
    fallthrough: false,
    immutable: true,
    index: false,
    lastModified: false,
    maxAge: moment.duration(2, "hours").asMilliseconds(),
    redirect: false,
  }));
}

(async function () {
  for (const job of JOBS) {
    for (const field of FIELDS) {
      const words = job._words[field];
      if (!words) {
        throw new ReferenceError(`Processed data for job ${job.ID} does not contain words for field ${field}`);
      }
      const key = db_job_words_key(job, field);
      await db_cmd("DEL", [key]);
      await db_cmd(`BF.RESERVE`, [key, 0.000000001, words.length]);
      await db_cmd(`BF.MADD`, [key, ...words]);
    }
    delete job._words;
  }

  if (ARGS["https-key"]) {
    // Redirect all HTTP requests to HTTPS server
    const redirect = express();
    redirect.use((req, res) => res.redirect(`https://${req.headers.host}${req.url}`));
    redirect.listen(80);

    https.createServer({
      key: await fs.readFile(ARGS["https-key"], "utf8"),
      cert: await fs.readFile(ARGS["https-cert"], "utf8"),
      ca: ARGS["https-ca"] && await fs.readFile(ARGS["https-ca"], "utf8"),
    }, server).listen(443, () => console.log(`HTTPS server has started`));
  } else {
    server.listen(3001, () => console.log(`Server has started`));
  }
})();

const valid_word = str => {
  // TODO
  return /^[\x20-\x7e]{1,50}$/.test(str);
};

const validate_query_parameters = query => {
  return {
    // toISOString will return null if invalid; `undefined - 1` is NaN
    after: moment.utc([query.after_year, query.after_month - 1, query.after_day]).toISOString(),
    rules: (query.rules_enabled || []).map((enabled_str, id) => {
      return {
        enabled: enabled_str === "true",
        words: ((query.rules_words || [])[id] || "").trim().split(/\s+/).filter(w => valid_word(w)).map(w => w.toLowerCase()),
        field: (query.rules_field || [])[id],
        mode: (query.rules_mode || [])[id],
      };
    }).filter(r => FIELDS.includes(r.field) && MODES.includes(r.mode) && r.words.length),
  };
};

const db_job_words_test = async (job, field, words) => {
  return await db_cmd(`BF.MEXISTS`, [db_job_words_key(job, field), ...words]);
};

const db_job_words_assert_mode = {
  "require": async (job, field, words) => {
    if (!words.length) {
      return;
    }
    const res = await db_job_words_test(job, field, words);
    if (res.some(r => !r)) {
      throw new ReferenceError(`Not all words matched`);
    }
  },
  "contain": async (job, field, words) => {
    if (!words.length) {
      return;
    }
    const res = await db_job_words_test(job, field, words);
    if (!res.some(r => r)) {
      throw new ReferenceError(`No words matched`);
    }
  },
  "exclude": async (job, field, words) => {
    if (!words.length) {
      return;
    }
    const res = await db_job_words_test(job, field, words);
    if (res.some(r => r)) {
      throw new ReferenceError(`Some words matched`);
    }
  },
};

server.get("/", (req, res) => res.redirect("/jobs"));

server.get("/jobs", async (req, res) => {
  let {after, rules} = validate_query_parameters(req.query);

  let jobs = JOBS;

  if (after) {
    jobs = jobs.filter(j => j.date > after);
  }

  const word_rules = {
    "require": {},
    "contain": {},
    "exclude": {},
  };

  for (const {enabled, words, field, mode} of rules) {
    if (!enabled) {
      continue;
    }
    if (!word_rules[mode][field]) {
      word_rules[mode][field] = new Set();
    }
    for (const word of words) {
      word_rules[mode][field].add(word);
    }
  }

  if (rules.length) {
    const word_rules_promises = [];
    for (const job of jobs) {
      const job_subpromises = [];
      for (const mode of Object.keys(word_rules)) {
        for (const field of Object.keys(word_rules[mode])) {
          const words = [...word_rules[mode][field]];
          job_subpromises.push(db_job_words_assert_mode[mode](job, field, words));
        }
      }
      word_rules_promises.push(Promise.all(job_subpromises).then(() => job, () => null));
    }

    jobs = (await Promise.all(word_rules_promises)).filter(j => j);
  }

  let overflow = false;
  if (jobs.length > MAX_RESULTS) {
    overflow = true;
    jobs = jobs.slice(0, MAX_RESULTS);
  }

  let now = moment();

  res.send(Page({
    // User-submitted form data
    afterYear: after && after.slice(0, 4),
    afterMonth: after && after.slice(5, 7),
    afterDay: after && after.slice(8, 10),
    rules: rules.map(r => ({
      ...r,
      words: r.words.join(" "),
    })),

    FIELDS: FIELDS,
    JOBS_COUNT: JOBS.length,

    // Results
    jobs: jobs,
    resultsCount: `${jobs.length}${overflow ? "+" : ""}`,
    noResults: !jobs.length,
    singleResult: jobs.length == 1,
    todayHumanDate: now.format("MMMM Do YYYY"),
  }));
});
