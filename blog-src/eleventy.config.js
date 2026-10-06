// Eleventy config for the Playground blog. Output goes to ../blog (gitignored);
// CI builds with --pathprefix /<repo>/blog/ so app links resolve under the Pages path.
// RSS helpers are imported as plain filters: addPlugin(rss) would also enable the HTML <base>
// plugin, which rewrites the app-root /js/... links under the blog path prefix.
import { dateToRfc3339, getNewestCollectionItemDate, convertHtmlToAbsoluteUrls } from "@11ty/eleventy-plugin-rss";
import syntaxHighlight from "@11ty/eleventy-plugin-syntaxhighlight";
import markdownItAnchor from "markdown-it-anchor";
import site from "./_data/site.js";

const WORDS_PER_MINUTE = 220;
const SEARCH_TEXT_CAP = 5000;
const LATEST_MAX = 10;
const EM_DASH = String.fromCharCode(0x2014);

const stripTags = (html) => String(html || "")
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
  .replace(/<\/?(?:p|li|ul|ol|h[1-6]|pre|div|br|tr|td|th|table|blockquote|figure|figcaption|hr)\b[^>]*>/gi, " ")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
  .replace(/\s+/g, " ")
  .trim();

const isoDate = (d) => new Date(d).toISOString();
const newestFirst = (items) => (items || []).slice().reverse();
const userTags = (tags) => (tags || []).filter((t) => t !== "posts" && t !== "all");

export default function (eleventyConfig) {
  eleventyConfig.addFilter("dateToRfc3339", dateToRfc3339);
  eleventyConfig.addFilter("getNewestCollectionItemDate", getNewestCollectionItemDate);
  eleventyConfig.addAsyncFilter("htmlToAbsoluteUrls", (html, base) => (html ? convertHtmlToAbsoluteUrls(html, base, { closingSingleTag: "slash" }) : ""));
  eleventyConfig.addPlugin(syntaxHighlight);

  // Plugins see the merged pathPrefix (config or --pathprefix); appRoot drops the trailing "blog/".
  eleventyConfig.addPlugin(function appRootPlugin(cfg) {
    const prefix = cfg.pathPrefix || "/";
    const withSlash = prefix.endsWith("/") ? prefix : prefix + "/";
    cfg.addGlobalData("pathPrefix", withSlash);
    cfg.addGlobalData("appRoot", withSlash.replace(/blog\/$/, ""));
  });

  // Drafts render under --serve and --watch, never in a production build.
  eleventyConfig.addPreprocessor("drafts", "*", (data) => {
    if (data.draft && process.env.ELEVENTY_RUN_MODE === "build") return false;
  });

  eleventyConfig.amendLibrary("md", (md) => {
    md.use(markdownItAnchor, {
      level: [2, 3],
      slugify: eleventyConfig.getFilter("slugify"),
      tabIndex: false,
      permalink: markdownItAnchor.permalink.headerLink({ safariReaderFix: true }),
    });
  });

  eleventyConfig.addPassthroughCopy({ "assets": "assets" });
  eleventyConfig.ignores.add("README.md");

  eleventyConfig.addFilter("absUrl", (url) => site.siteUrl + "blog" + (url || "/"));
  eleventyConfig.addFilter("siteAbsUrl", (p) => (/^https?:\/\//.test(p) ? p : site.siteUrl + String(p || "").replace(/^\/+/, "")));
  eleventyConfig.addFilter("isoDate", isoDate);
  eleventyConfig.addFilter("readableDate", (d) => new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }));
  eleventyConfig.addFilter("newestFirst", newestFirst);
  eleventyConfig.addFilter("userTags", userTags);
  eleventyConfig.addFilter("readingTime", (html) => {
    const words = stripTags(html).split(" ").filter(Boolean).length;
    return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
  });

  // Table of contents from rendered h2/h3 ids (markdown-it-anchor output).
  eleventyConfig.addFilter("toc", (html) => {
    const items = [];
    const re = /<h([23])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gi;
    for (const m of String(html || "").matchAll(re)) {
      items.push({ level: Number(m[1]), id: m[2], text: stripTags(m[3]) });
    }
    return items;
  });

  // JSON for <script type="application/ld+json">: "<" escaped so "</script>" can never close the tag.
  eleventyConfig.addFilter("jsonScript", (obj) => JSON.stringify(obj).replace(/</g, "\\u003c"));

  eleventyConfig.addFilter("searchIndex", (posts) => JSON.stringify(newestFirst(posts).map((p) => ({
    title: p.data.title,
    url: p.url,
    description: p.data.description || "",
    tags: userTags(p.data.tags),
    date: isoDate(p.date),
    text: stripTags(p.content).slice(0, SEARCH_TEXT_CAP),
  }))));

  // Feed for the SPA home strip: url is relative to the app root ("blog/<slug>/").
  eleventyConfig.addFilter("latestPosts", (posts) => JSON.stringify(newestFirst(posts).slice(0, LATEST_MAX).map((p) => ({
    title: p.data.title,
    url: "blog" + p.url,
    date: isoDate(p.date),
    description: p.data.description || "",
    tags: userTags(p.data.tags),
  }))));

  eleventyConfig.addCollection("tagList", (api) => {
    const set = new Set();
    for (const item of api.getFilteredByTag("posts")) userTags(item.data.tags).forEach((t) => set.add(t));
    return [...set].sort((a, b) => a.localeCompare(b));
  });

  // House style: no em-dashes in published posts.
  eleventyConfig.addLinter("no-em-dash", function (content) {
    const input = (this.page && this.page.inputPath) || "";
    if (/[\\/]posts[\\/]/.test(input) && content.includes(EM_DASH)) {
      throw new Error(`Em-dash found in ${input}; use a colon, comma or parentheses instead.`);
    }
  });

  return {
    pathPrefix: "/blog/",
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    dir: {
      input: ".",
      includes: "_includes",
      data: "_data",
      output: "../blog",
    },
  };
}
