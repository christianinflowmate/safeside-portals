# Bundled artwork

Extracted from Safeside's own proposal PDFs. Both files are byte-identical across
every sample client, which is how we know they are template assets and carry no
client data.

- `employee-directory.jpg` — the Employee Directory page, a flattened image in the
  source document. Safeside's own staff listing; no client information.
- `watermark-shield.jpg` — the faint shield watermark used as a page background.

- `cover-art.jpg` — the cover photograph: shield, skyline, and the Safeside logo
  and tagline along the bottom.

## How cover-art.jpg was obtained

The cover in Safeside's proposals is the WHOLE PAGE flattened into one JPEG, with
the client's name and address burned into the pixels. It differs for every client,
so the file cannot be reused as-is.

Both the title and the client address sit in the top quarter of that image, above
the shield. This asset is that image cropped below them (at y=560 of 2199), which
removes both without needing to reconstruct anything. The title and client block
are rendered as live text above it.

Two inpainting attempts were made first — copying adjacent sky, then a diffusion
fill — and both left a visibly patched rectangle, because the region borders
high-contrast cloud and building edges. Cropping is the honest answer.

Still worth asking Safeside for the original artwork: it would allow the title to
sit over the photograph the way it does in theirs, rather than in a band above it.
