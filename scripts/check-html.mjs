import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8");
const match = html.match(/<script>([\s\S]*)<\/script>/);

if (!match) {
  throw new Error("No inline script found in public/index.html");
}

new Function(match[1]);
console.log("html script ok");
