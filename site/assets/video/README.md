# Explainer video

This folder holds the captions for "What are plugins and skills?", the video in the site's Questions section.
The video and its poster are served from this folder too, but they are not committed on `main`: the build copies them in from the `site-media` branch, pinned by `site/media.json`, so marketplace clones of `main` stay small.
See [Site media](../../README.md#site-media) for how to replace them, and keep these captions and `video.transcript` in `site/catalog.json` in step with the video.

## How the film was made

Everything in it was generated locally.
Nothing was recorded, licensed, or sent to an online service.

- **Voice:** the Kokoro 82M text-to-speech model (Apache 2.0) with the kokoro-onnx runtime (MIT).
- **Picture:** drawn frame by frame in Python with the site's own fonts (SIL Open Font License) and Microsoft's official Power Pages icon, under the terms in [`../brand/README.md`](../brand/README.md).
- **Music and sound effects:** original, synthesized in code.

## What is real and what is illustrative

- The Power Pages plugin, its five skills, and the steps shown for `/create-site` and `/deploy-site` come from the plugin's skills.
- The assistant window, the "Allow this command?" prompt, and the `npm run build` command are illustrations, not the interface of any one AI assistant.
- "It asks before it runs commands or changes files" describes the assistants' default permission settings, which a user can change.
