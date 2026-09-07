
## Nytt i STABLE 1.2
- Kildebasert vannprofil i vannlisten: bestand, areal der det finnes sikre data, adkomst, spesialregler og kildegrad.
- Bestandskunnskap fra Inatur/FishKing påvirker rangering bare når en åpen kilde faktisk dokumenterer arten.
- Dokumenterte ørret-only-vann nedprioriteres i abbor-modus og omvendt.
- FishKing-omtalte småvann markeres som lokale «skattekister», uten å late som dagens bestand er garantert.
- Områdekunnskap: 96 vann totalt, 45 med ørret, kalking siden 1990, årlig utsetting, fire fluevann og to fiskebrygger.
- Klikk på et vann forsøker kartmatch med lokale/offentlige navnealias og viser kartberegnet areal fra OSM-vannpolygon når tilgjengelig.
- Kildelenker i appen til Inatur, FishKing, Finnfisk/NVE og Store Le-kartet.

# Vestfjella Fiske – STABLE 1.2

Dette er ferskvannsutgaven av den fungerende **Fiste REV26-motoren**, tilpasset Vestfjella/Aremark.

## Viktigste forskjell fra den gamle Vestfjella REV4

Den gamle løsningen brukte et separat koordinat-/verifiseringslag og kunne ende med `0 kartverifisert`. Denne utgaven bruker Fiste-motorens vannmaskelogikk direkte:

- anbefalingspunkter genereres i **faktiske OSM-vannflater**
- hvis OSM-polygonoppslaget er tregt eller nede, brukes en sikker **raster-vannkontroll** fra OSM-kartflisene
- et rasterpunkt godtas bare når punktet er vann og motoren finner en vannkant
- gamle estimerte Vestfjella-koordinater brukes ikke som anbefalingspunkter

## Innhold

- Ørret, abbor eller «Ingen – vis ørret + abbor»
- Mest fisk / STOR FISK
- base + 250 m / 500 m / 1 km / 2 km / ingen grense
- standardkart, satellitt og hybrid
- valgfritt NVE-dybdekart
- MET Norway-vær
- NVE HydAPI når `NVE_API_KEY` finnes
- fangstlogg, personlige mønstre, GPX og JSON-backup
- 92 lokale Vestfjella-navn i eget register
- fire kjente fluevann merkes og får bare flueanbefalinger
- 29 enkeltbeskårne agn fra brukerens egne bilder
- slukmotoren varierer mellom egnede agn etter sted og forhold i stedet for å vise samme sluk på alle soner

## Enkel opplasting til GitHub/Render

1. Pakk ut ZIP-filen.
2. Gå til GitHub-repoet som Render bruker.
3. **Add file → Upload files**.
4. Dra inn alt innholdet i denne mappen og commit til `main`.
5. Render deployer automatisk. Hvis ikke: **Manual Deploy → Deploy latest commit**.
6. Åpne `/api/health` på Render-adressen. Den skal vise `Vestfjella Fiske` og `stable-1.2`.

Det er under 100 filer i pakken, så den kan lastes opp i én omgang via GitHub-nettsiden.

## Lokalt

Krever Node.js 20+.

```bash
npm ci
npm test
npm start
```

Åpne `http://localhost:3000`.

## Viktig

De 92 navnene er et områderegister og brukes ikke som fiktive kartkoordinater. Lokale navn kan avvike fra navn i OpenStreetMap/offentlige kart. Soner tegnes bare der Fiste-motoren kan bekrefte en vannflate.
