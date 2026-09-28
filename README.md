# Vestfjella Fiske / Fiste 2 – STABLE 1.7

Mobilførst fiskeguide for Vestfjella i Marker/Aremark. Denne versjonen bygger videre på den lokale Vestfjella-logikken, men har fått kart-, NVE-, 3D- og BiteGuide-forbedringene fra den nyeste Fiste-motoren.

## Beholdt fra Vestfjella
- 92 kjente vann i eget register.
- Ørret og abbor, samt «Ingen – vis ørret + abbor».
- Tilkomstfilter.
- Kjente fluevann og flue-only-logikk.
- Brukerens egne fotograferte sluk/fluer og Vestfjella-spesifikke anbefalinger.
- Live GPS, fangstlogg, GPX/JSON og lokale vannprofiler.

## Nytt i STABLE 1.7

### Automatisk NVE-fiskekart
«Fiskekart – NVE dybder» er standardkart. Appen identifiserer riktig innsjø med NVE `vatnLnr`, sjekker at akkurat samme vann har dybdemålinger, og henter deretter dybdekurver og dybdepunkter. Den låner ikke dybder fra nabovann.

Når NVE har oppmålte data vises:
- fylte blå dybdesoner
- NVE-dybdekoter og dybdeetiketter
- måle-/kvalitetsinformasjon
- samme NVE-grunnlag i 3D-bunn

Hvis NVE ikke har oppmålt vannet, vises topo uten oppdiktede dybder.

### 3D bunn / terreng
3D-ferskvann bruker NVE-måledata der de finnes. Innebygd Canvas-visning gjør at 3D fortsatt kan fungere dersom det eksterne 3D-biblioteket ikke lastes på telefonen.

### BiteGuide
BiteGuide beregner først en uavhengig idealprofil for punktet: type, farge, størrelse/vekt, måldybde, presentasjon og BiteTime. Deretter matches dine egne fotograferte sluk/fluer mot profilen. Egne sluk velges derfor ikke tilfeldig og er ikke selve kilden til idealanbefalingen.

### Vestfjella-vann
«Kjente vann – beste først» beholder registeret med 92 vann. Du kan trykke et vann for å flytte kartet dit. Tilkomst og kjent lokal vanninfo brukes fortsatt i rangeringen.

## Automatisk oppdatering til GitHub + Render

Denne pakken er koblet til **Fiste 2**, ikke Fiste 1:
- GitHub: `aikongen2026/FISTE-2`
- Render: `https://fiste-2.onrender.com`

Pakk ut ZIP-en og dobbeltklikk `1-OPPDATER-OG-APNE-FISTE.bat`. Scriptet synkroniserer prosjektet, lager commit, pusher til FISTE-2, venter på Render Auto-Deploy og åpner appen når STABLE 1.7 er live.

Første gang på en ny PC kan Git Credential Manager kreve én GitHub-godkjenning. Ingen token eller passord lagres i pakken.

## Lokalt
Krever Node.js 20+.

```bash
npm install
npm test
npm start
```

Åpne `http://localhost:3000`.
