#!/bin/bash
# Generate PNG icons from SVG
# Requires: inkscape or imagemagick (optional - SVG works for most browsers)

cd "$(dirname "$0")/public/icons"

# Check for inkscape
if command -v inkscape &> /dev/null; then
    echo "Generating PNG icons with Inkscape..."
    inkscape icon.svg --export-type=png --export-width=192 --export-height=192 --export-filename=icon-192.png
    inkscape icon.svg --export-type=png --export-width=512 --export-height=512 --export-filename=icon-512.png
    inkscape icon.svg --export-type=png --export-width=192 --export-height=192 --export-filename=icon-maskable-192.png
    inkscape icon.svg --export-type=png --export-width=512 --export-height=512 --export-filename=icon-maskable-512.png
    echo "Done! PNG icons generated."
# Check for imagemagick
elif command -v convert &> /dev/null; then
    echo "Generating PNG icons with ImageMagick..."
    convert -background none icon.svg -resize 192x192 icon-192.png
    convert -background none icon.svg -resize 512x512 icon-512.png
    convert -background none icon.svg -resize 192x192 icon-maskable-192.png
    convert -background none icon.svg -resize 512x512 icon-maskable-512.png
    echo "Done! PNG icons generated."
else
    echo "Neither Inkscape nor ImageMagick found."
    echo "SVG icon is already configured and works in modern browsers."
    echo "To generate PNG icons, install inkscape or imagemagick and re-run this script."
fi
