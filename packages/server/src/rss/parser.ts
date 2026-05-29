import Parser from "rss-parser"

export const rssParser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "RSSFed/0.1.0",
  },
})