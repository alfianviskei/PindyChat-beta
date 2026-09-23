/**
 * Patch the login page JS bundle to add "PindyChat" text below the logo.
 * Runs inside the Docker container where only Node.js is available.
 */
const fs = require("fs");
const path = require("path");

// Match both original and previously-patched versions
const ORIGINAL =
  "(0,$.jsx)(`div`,{className:`mt-6 h-10 w-full bg-cover`," +
  "children:(0,$.jsx)(`img`,{src:`assets/logo.svg`," +
  "className:`h-full w-full object-contain`," +
  "alt:s(`com_ui_logo`,{0:r?.appTitle??`PindyChat`})})})";

const PREVIOUS_PATCH =
  "(0,$.jsxs)(`div`,{className:`mt-6 flex flex-col items-center`," +
  "children:[(0,$.jsx)(`div`,{className:`h-16 w-full bg-cover`," +
  "children:(0,$.jsx)(`img`,{src:`assets/logo.svg`," +
  "className:`h-full w-full object-contain`," +
  "alt:s(`com_ui_logo`,{0:r?.appTitle??`PindyChat`})})})" +
  ",(0,$.jsx)(`p`,{className:`mt-2 text-2xl font-semibold text-text-primary`," +
  "children:`PindyChat`})]})";

const NEW =
  "(0,$.jsxs)(`div`,{className:`mt-8 flex flex-col items-center gap-4`," +
  "children:[(0,$.jsx)(`img`,{src:`assets/logo.svg`," +
  "className:`h-28 w-28 object-contain drop-shadow-lg`," +
  "alt:s(`com_ui_logo`,{0:r?.appTitle??`PindyChat`})})" +
  ",(0,$.jsx)(`h1`,{className:`text-4xl font-bold text-text-primary tracking-tight`," +
  "children:`PindyChat`})]})";

const dist = "/app/client/dist/assets";
let patched = 0;

for (const file of fs.readdirSync(dist)) {
  if (!file.endsWith(".js")) continue;
  const filePath = path.join(dist, file);
  let content = fs.readFileSync(filePath, "utf8");
  let didPatch = false;
  if (content.includes(PREVIOUS_PATCH)) {
    content = content.replace(PREVIOUS_PATCH, NEW);
    didPatch = true;
    console.log("Replaced previous patch in:", filePath);
  } else if (content.includes(ORIGINAL)) {
    content = content.replace(ORIGINAL, NEW);
    didPatch = true;
    console.log("Replaced original in:", filePath);
  }
  if (didPatch) {
    fs.writeFileSync(filePath, content, "utf8");
    patched++;
  }
}

if (patched === 0) {
  console.log("WARNING: pattern not found in any JS file");
} else {
  console.log(`Done. Patched ${patched} file(s).`);
}
