"""Build a local VSIX from runtime files using the Python standard library, with require-graph verification."""
import json
import os
import re
import stat
import sys
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
output = root / f"{pkg['name']}-{pkg['version']}.vsix"
# Manifest text lives in package.nls.json (English) and package.nls.<locale>.json.
nls = json.loads((root / "package.nls.json").read_text(encoding="utf-8"))
nls_files = sorted(path.name for path in root.glob("package.nls*.json"))


def localized(value):
    match = re.fullmatch(r"%([^%]+)%", value or "")
    if not match:
        return value
    if match.group(1) not in nls:
        sys.exit(f"ERROR: package.nls.json has no entry for {value}")
    return nls[match.group(1)]

manifest = ET.Element("PackageManifest", {
    "Version": "2.0.0", "xmlns": "http://schemas.microsoft.com/developer/vsx-schema/2011"
})
metadata = ET.SubElement(manifest, "Metadata")
ET.SubElement(metadata, "Identity", {
    "Language": "en-US", "Id": pkg["name"], "Version": pkg["version"], "Publisher": pkg["publisher"],
})
ET.SubElement(metadata, "DisplayName").text = localized(pkg["displayName"])
ET.SubElement(metadata, "Description").text = localized(pkg["description"])
ET.SubElement(metadata, "Categories").text = ",".join(pkg.get("categories", ["Other"]))
if (root / "media/icons/app.png").is_file():
    ET.SubElement(metadata, "Icon").text = "extension/media/icons/app.png"
properties = ET.SubElement(metadata, "Properties")
for key, value in {"Engine": pkg["engines"]["vscode"], "ExtensionKind": "ui"}.items():
    ET.SubElement(properties, "Property", {"Id": "Microsoft.VisualStudio.Code." + key, "Value": value})
ET.SubElement(ET.SubElement(manifest, "Installation"), "InstallationTarget", {"Id": "Microsoft.VisualStudio.Code"})
ET.SubElement(manifest, "Dependencies")
assets = ET.SubElement(manifest, "Assets")
asset_map = {"Code.Manifest": "package.json", "Services.Content.Details": "README.md"}
if (root / "media/icons/app.png").is_file():
    asset_map["Services.Icons.Default"] = "media/icons/app.png"
for key, file in asset_map.items():
    ET.SubElement(assets, "Asset", {"Type": "Microsoft.VisualStudio." + key, "Path": "extension/" + file,
                                    "Addressable": "true"})

types = ET.Element("Types", {"xmlns": "http://schemas.openxmlformats.org/package/2006/content-types"})
for suffix, mime in {
    "json": "application/json",
    "cjs": "application/javascript",
    "md": "text/markdown",
    "css": "text/css",
    "js": "application/javascript",
    "svg": "image/svg+xml",
    "png": "image/png",
    "gif": "image/gif",
    "icns": "image/icns",
    "plist": "application/xml",
    "strings": "text/plain",
    "vsixmanifest": "text/xml",
}.items():
    ET.SubElement(types, "Default", {"Extension": suffix, "ContentType": mime})

# Automatically discover all runtime CJS modules and assets.
files = [
    "package.json",
    *nls_files,
    "README.md",
    "media/sessions.svg",
    "media/panel.css",
]
for media_js in sorted((root / "media").glob("*.js")):
    files.append(media_js.relative_to(root).as_posix())
for optional in ["LICENSE", "README.ko.md"]:
    if (root / optional).is_file():
        files.append(optional)
for src_file in sorted((root / "src").glob("*.cjs")):
    files.append(src_file.relative_to(root).as_posix())
icons_dir = root / "media/icons"
if icons_dir.is_dir():
    for icon_file in sorted(icons_dir.iterdir()):
        if icon_file.is_file() and icon_file.suffix in {".png", ".svg"}:
            files.append(icon_file.relative_to(root).as_posix())

notifier_app = root / "native/AgentSessionNotifier.app"
if notifier_app.is_dir():
    for app_file in sorted(notifier_app.rglob("*")):
        if app_file.is_file():
            files.append(app_file.relative_to(root).as_posix())

# Verify every local require() inside the runtime scripts is included in the VSIX.
included = set(files)
require_re = re.compile(r"""require\(\s*['"](\.\.?/[^'"]+)['"]\s*\)""")
missing = []
for rel in list(included):
    if not rel.endswith((".cjs", ".js")):
        continue
    src_path = root / rel
    text = src_path.read_text(encoding="utf-8")
    for match in require_re.finditer(text):
        target = (src_path.parent / match.group(1)).resolve()
        try:
            target_rel = target.relative_to(root).as_posix()
        except ValueError:
            missing.append(f"{rel} -> {match.group(1)} (outside project)")
            continue
        if target_rel not in included:
            missing.append(f"{rel} -> {target_rel}")
if missing:
    print("ERROR: Missing required modules in VSIX:", ", ".join(missing), file=sys.stderr)
    sys.exit(1)

with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as vsix:
    vsix.writestr("[Content_Types].xml", ET.tostring(types, encoding="utf-8", xml_declaration=True))
    vsix.writestr("extension.vsixmanifest", ET.tostring(manifest, encoding="utf-8", xml_declaration=True))
    for rel in files:
        full = root / rel
        st = full.stat()
        info = zipfile.ZipInfo("extension/" + rel)
        info.compress_type = zipfile.ZIP_DEFLATED
        # Preserve POSIX file permissions (critical for AgentSessionNotifier Mach-O executable bit).
        mode = stat.S_IFREG | (0o755 if (st.st_mode & 0o111) else 0o644)
        info.external_attr = mode << 16
        vsix.writestr(info, full.read_bytes())

print(output)
