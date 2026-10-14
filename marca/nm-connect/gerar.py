#!/usr/bin/env python3
"""Gera icone.svg, logo.svg e logo-escuro.svg do NM Connect.

O texto do logo é convertido em contornos (paths) da Inter (SIL OFL 1.1), então
os SVGs não dependem de fonte instalada. Requer `fonttools` (num venv qualquer):

    python3 -m venv /tmp/v && /tmp/v/bin/pip install fonttools
    /tmp/v/bin/python marca/nm-connect/gerar.py /caminho/InterVariable.ttf marca/nm-connect

PNGs (a tela /admin/marca só aceita PNG/JPG):

    rsvg-convert -h 192 logo.svg -o logo.png
    rsvg-convert -h 192 logo-escuro.svg -o logo-escuro.png
    rsvg-convert -w 512 -h 512 icone.svg -o icone-512.png
"""
import re
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

FONTE, OUT = sys.argv[1], sys.argv[2]


def run(text, wght, size, x0, baseline, tracking=0.0):
    f = TTFont(FONTE)
    eixos = [a.axisTag for a in f["fvar"].axes]
    f = instantiateVariableFont(f, {"wght": wght, "opsz": 32} if "opsz" in eixos else {"wght": wght})
    s = size / f["head"].unitsPerEm
    gs, cmap, hmtx = f.getGlyphSet(), f.getBestCmap(), f["hmtx"]
    x, d = x0, []
    for ch in text:
        g = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[g].draw(TransformPen(pen, (s, 0, 0, -s, x, baseline)))
        d.append(pen.getCommands())
        x += hmtx[g][0] * s + tracking * size
    return " ".join(d), x


ACC='#B3261E'; ACC_D='#EF6B63'; INK='#1B1A17'; PAPER='#F2F0EA'
def r(d): return re.sub(r'-?\d+\.\d+', lambda m: ('%.2f'%float(m.group())).rstrip('0').rstrip('.'), d)
# simbolo em 64x64
BUBBLE='M21 13H43A9 9 0 0 1 52 22V36A9 9 0 0 1 43 45H24L15 53V44.2A9 9 0 0 1 12 36V22A9 9 0 0 1 21 13Z'
ZIG='M21.5 36V22L30.5 36V22L36.5 31L42.5 22V36'
def simbolo(tile, bubble, line, tx=0, ty=0, s=1.0):
    return (f'<g transform="translate({tx} {ty}) scale({s})">'
            f'<rect width="64" height="64" rx="14" fill="{tile}"/>'
            f'<path d="{BUBBLE}" fill="{bubble}"/>'
            f'<path d="{ZIG}" fill="none" stroke="{line}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>'
            '</g>')
icone=('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="NM Connect">'
       '<title>NM Connect</title>'+simbolo(ACC,'#FFFFFF',ACC)+'</svg>\n')
open(f'{OUT}/icone.svg','w').write(icone)
H=48; size=30; cap=0.727*size; bl=round(H/2+cap/2,2)
d1,x=run('NM',700,size,62,bl,-0.01)
d2,x2=run('Connect',500,size,x+7,bl,-0.01)
W=round(x2+2)
def logo(nm, connect, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="NM Connect">'
            f'<title>{title}</title>'+simbolo(ACC,'#FFFFFF',ACC,0,0,0.75)+
            f'<path fill="{nm}" d="{r(d1)}"/><path fill="{connect}" d="{r(d2)}"/></svg>\n')
open(f'{OUT}/logo.svg','w').write(logo(ACC,INK,'NM Connect'))
open(f'{OUT}/logo-escuro.svg','w').write(logo(ACC_D,PAPER,'NM Connect (fundo escuro)'))
print(W,H)
