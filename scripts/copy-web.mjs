import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/web/", import.meta.url), { recursive: true });
for (const name of ["index.html", "styles.css"]) {
  await copyFile(
    new URL(`../src/web/${name}`, import.meta.url),
    new URL(`../dist/web/${name}`, import.meta.url),
  );
}
