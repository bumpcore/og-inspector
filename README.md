# OG Inspector

A Chrome extension for debugging Open Graph images. Click the toolbar icon and see how the page you're on will look when it gets shared.

![icon](icons/icon-128.png)

## What it shows

- **The share image** with its real dimensions, aspect ratio, file size, content type and HTTP status.
- **Checks**: missing tags, relative or `http` image URLs, images that are too small, too large, the wrong ratio, SVG, or failing to load, declared `og:image:width/height` that don't match the file, and tags that only appear after JavaScript runs.
- **Previews** approximating Facebook, X (large and summary cards), LinkedIn, Discord, Slack and WhatsApp.
- **Tags**: every `og:*`, `twitter:*`, `article:*`, `description` and canonical tag, with one-click copy.

### Crawler vs Live DOM

By default the extension re-fetches the URL without cookies and parses the raw HTML, the way link-preview crawlers do. Switch to **Live DOM** to see the tags in the tab after JavaScript has run. If a tag exists only in the live DOM, you get a warning: crawlers won't see it.

Previews are approximations. To force a platform to refresh its cache, use the Facebook and LinkedIn links in the footer.

## Install

1. Download the latest `og-inspector-*.zip` from [Releases](https://github.com/bumpcore/og-inspector/releases) and unzip it, or clone this repo.
2. Open `chrome://extensions` (`brave://extensions` in Brave, `edge://extensions` in Edge).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Pin the extension from the puzzle-piece menu.

## Permissions

- `activeTab` + `scripting`: read the current tab's DOM when you open the popup.
- Host access to all sites: fetch the page's raw HTML and its images without CORS getting in the way. Nothing is sent anywhere else; there is no analytics and no remote server.

## Development

Plain JavaScript, no build step. Edit the files, then hit the reload button on the extension card in `chrome://extensions`.

To build a release zip:

```sh
./scripts/pack.sh
```

## License

MIT
