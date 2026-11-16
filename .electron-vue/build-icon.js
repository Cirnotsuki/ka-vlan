const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const pngToIco = require("png-to-ico").default;

const ROOT = path.join(__dirname, "..");
const SOURCE_DIR = path.join(ROOT, "icons");
const OUTPUT_DIR = path.join(ROOT, "static");

// ICO 包含的尺寸
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TRAY_SIZES = [16, 24, 32];

async function handle(sizes, source, dist) {
    const icoBuffers = [];

    for (const size of sizes) {
        const buffer = await sharp(source)
            .resize(size, size, {
                fit: "contain",
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer();

        icoBuffers.push(buffer);
    }

    const icoBuffer = await pngToIco(icoBuffers);

    fs.writeFileSync(dist, icoBuffer);

    console.log(`[Icons] Generated: ${dist}`);
}
async function buildIcons() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    for (const name of fs.readdirSync(SOURCE_DIR)) {
        const source = path.join(SOURCE_DIR, name);
        if (fs.statSync(source).isDirectory()) continue;
        if (!fs.existsSync(source)) {
            throw new Error(`找不到图标文件：${source}`);
        }
        const icoName = path.basename(name, ".png");

        // fs.writeFileSync(output, pngBuffer);
        if (icoName === "icon") {
            await handle(ICO_SIZES, source, path.join(OUTPUT_DIR, icoName + ".ico"));
        }
        await handle(TRAY_SIZES, source, path.join(OUTPUT_DIR, "tray-" + icoName + ".ico"));

        // 主应用图标额外生成 ICO
    }

    const ContextDir = path.join(SOURCE_DIR, "contextmenu");
    if (fs.existsSync(ContextDir)) {
        for (const name of fs.readdirSync(ContextDir)) {
            const source = path.join(ContextDir, name);

            if (!fs.existsSync(source)) {
                throw new Error(`找不到图标文件：${source}`);
            }

            await sharp(source)
                .resize(16, 16, {
                    fit: "contain",
                    background: { r: 0, g: 0, b: 0, alpha: 0 },
                })
                .png({
                    compressionLevel: 9,
                    palette: false,
                    force: true,
                })
                .toFile(path.join(OUTPUT_DIR, "menu-" + name));

            // 主应用图标额外生成 ICO
        }
    }

    console.log("[Icons] All icons generated successfully.");
}

buildIcons().catch((error) => {
    console.error("[Icons] Build failed:", error);
    process.exitCode = 1;
});
