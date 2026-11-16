# Brand assets

The SVG files here are Microsoft's official Power Platform product icons, copied unchanged from the
[Microsoft Power Platform icons](https://learn.microsoft.com/power-platform/guidance/icons) download
(`Power-Platform-icons-scalable.zip`, December 2025 update).

| File | Source file in the download | Represents |
| --- | --- | --- |
| `power-platform.svg` | `Power Platform/PowerPlatform_scalable.svg` | Microsoft Power Platform |
| `power-apps.svg` | `Power Platform/PowerApps_scalable.svg` | Power Apps |
| `power-automate.svg` | `Power Platform/PowerAutomate_scalable.svg` | Power Automate |
| `power-pages.svg` | `Power Platform/PowerPages_scalable.svg` | Power Pages |
| `dataverse.svg` | `Power Platform/Dataverse_scalable.svg` | Dataverse |

`favicon-32.png` and `apple-touch-icon.png` are rasterized from `power-platform.svg` without
cropping, recoloring, or distortion.
The home-screen icon sits on a white tile because iOS fills transparent areas with black.

## Terms

Microsoft's [icon page](https://learn.microsoft.com/power-platform/guidance/icons) and the
`CELA_Licenses_Public_Use_Icons.pdf` in the download set these terms:

- Microsoft permits the use of these icons in architectural diagrams, training materials, or documentation.
- Don't crop, flip, or rotate icons, and don't distort or change their shape.
- Don't use Microsoft product icons to represent your product or service.
- Show the service's full name near the icon (from the FAQ in the download).

## Where the site uses them

- Each product icon appears beside a plugin to show which Microsoft product it works with, with the
  product's name next to it (`PRODUCTS` in `site/lib/catalog.js`). A test checks every use.
- The Power Platform icon appears in the header and footer next to the "Power Platform Skills" name,
  and as the favicon, to identify this Microsoft-published Power Platform site.

Because the terms list the permitted uses narrowly, check Microsoft's brand guidance before using
these files anywhere else, and replace them only with a newer version from the same download page.
