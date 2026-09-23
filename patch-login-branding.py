#!/usr/bin/env python3
"""Patch the login page JS bundle to add 'PindyChat' text below the logo."""
import glob
import os

OLD = (
    "(0,$.jsx)(`div`,{className:`mt-6 h-10 w-full bg-cover`,"
    "children:(0,$.jsx)(`img`,{src:`assets/logo.svg`,"
    "className:`h-full w-full object-contain`,"
    "alt:s(`com_ui_logo`,{0:r?.appTitle??`PindyChat`})})})"
)

NEW = (
    "(0,$.jsxs)(`div`,{className:`mt-6 flex flex-col items-center`,"
    "children:[(0,$.jsx)(`div`,{className:`h-10 w-full bg-cover`,"
    "children:(0,$.jsx)(`img`,{src:`assets/logo.svg`,"
    "className:`h-full w-full object-contain`,"
    "alt:s(`com_ui_logo`,{0:r?.appTitle??`PindyChat`})})})"
    ",(0,$.jsx)(`p`,{className:`mt-2 text-xl font-semibold text-text-primary`,"
    "children:`PindyChat`})]})"
)

def main():
    dist = "/app/client/dist/assets"
    patched = 0
    for js_file in glob.glob(os.path.join(dist, "*.js")):
        with open(js_file, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        if OLD in content:
            content = content.replace(OLD, NEW, 1)
            with open(js_file, "w", encoding="utf-8") as f:
                f.write(content)
            patched += 1
            print(f"Patched: {js_file}")
    if patched == 0:
        print("WARNING: pattern not found in any JS file")
    else:
        print(f"Done. Patched {patched} file(s).")

if __name__ == "__main__":
    main()
