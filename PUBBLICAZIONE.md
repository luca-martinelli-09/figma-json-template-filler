# Pubblicare JSON Template Filler sulla Figma Community

## 1. Prima di pubblicare

- [ ] **Autenticazione a due fattori** attiva sull'account Figma (obbligatoria per pubblicare).
- [ ] **ID ufficiale** già nel manifest: `1685286769679044469`.
- [ ] **Prova completa** nell'app desktop (Plugins → Development → Import plugin from manifest…):
  - [ ] Figma Buzz: scansione, generazione di un carosello, nuova riga in fondo con il nome del set;
  - [ ] Figma Design: generazione in un frame affiancato al contenuto;
  - [ ] grassetto e corsivo, campo `null` che nasconde il livello, immagine da URL, `note` mostrate a fine generazione;
  - [ ] JSON non valido e template inesistente: messaggi di errore e avvisi chiari.
- [ ] **Codice aggiornato**: dopo ogni modifica a `code.ts`, `npm run build` per rigenerare `code.js`.
- [ ] **Nome libero**: cerca "JSON Template Filler" sulla Community per verificare che non esista già.

## 2. Dove si pubblica

Plugins → Development → Manage plugins in development → accanto al plugin, **Publish**.

## 3. Testi da incollare (in inglese)

**Name**
```
JSON Template Filler
```

**Tagline**
```
Turn a JSON into slides, posts and carousels from your own components.
```

**Description**
```
Generate carousels, social posts and slide sets from your own components with a simple JSON.

HOW IT WORKS
1. Build your templates as local components and give clear names to the layers you want to fill (Title, Body, Photo…).
2. Press "Scan templates": the plugin writes an example JSON with every component and all its fillable layers.
3. Fill in the JSON with your content, or paste/drop a JSON you prepared elsewhere.
4. Press "Generate": one instance per item, every layer filled by name.

FEATURES
• Works in Figma Design and Figma Buzz. In Buzz each set lands in a new row of the canvas grid; in Design in a new auto-layout frame.
• **bold** and *italic* inside text, using the styles of the font already in your template.
• null hides a layer: with auto layout the gap closes by itself.
• Image layers filled from direct image URLs.
• Variants of component sets and component properties.
• "note" reminders shown after generation, e.g. which picture still needs to be added.
• Live JSON validation and drag & drop of .json files.

JSON EXAMPLE
{
  "name": "Episode 39",
  "slides": [
    { "template": "Cover", "fields": { "Title": "Hello **world**" } },
    { "template": "Text slide", "fields": { "Title": null, "Body": "Some text" } }
  ]
}

PRIVACY
The plugin only reads and edits the current file. It does not collect or send any data. The only network requests are the image URLs you put in the JSON and Google Fonts for the interface font.
```

**Category**: Design tools

**Tags** (fino a 12):
```
json, template, carousel, instagram, social media, content, automation, data, components, figma buzz, bulk, populate
```

## 4. Immagini (cartella `assets`)

| Campo del modulo | File |
|---|---|
| Icon (128×128) | `icon-128.png` |
| Thumbnail / cover (1920×1080) | `cover-1920x1080.png` |
| Carousel, immagine 1 | `screenshot-1-scan.png` |
| Carousel, immagine 2 | `screenshot-2-generate.png` |
| Carousel, immagine 3 | `screenshot-3-rules.png` |

Facoltativo ma consigliato: un breve video (anche una registrazione dello schermo) della generazione in Buzz, e un **playground file**, cioè un file Figma pubblico con 3–4 componenti d'esempio (Cover, Text slide, Image slide, End) già pronti da provare.

## 5. Accesso alla rete

Seleziona **Unrestricted** e come motivazione:
```
Image fields in the JSON are URLs chosen by the user, so the plugin must be able to download images from any domain. The interface also loads the Inter font from Google Fonts. No user data is sent anywhere.
```

## 6. Sicurezza dei dati (questionario facoltativo)

Risposte coerenti con il comportamento del plugin:
- **Raccoglie o conserva dati degli utenti?** No.
- **Invia contenuti del file a server esterni?** No.
- **Servizi di terze parti?** Solo Google Fonts per il font dell'interfaccia; le immagini vengono scaricate dagli URL indicati dall'utente.
- **Autenticazione o account?** No.
- **Analytics o tracciamento?** No.

La revisione del questionario può richiedere fino a due settimane e non blocca la pubblicazione del plugin.

## 7. Altri campi

- **Support contact**: un'email o la pagina del repository, se pubblichi il codice su GitHub.
- **Publish to**: Community.
- **Pricing**: Free.
- **Comments**: attivi (utili per ricevere segnalazioni).

## 8. Dopo l'invio

- Il plugin resta "In review"; l'esito arriva via email. Durante la revisione si possono pubblicare aggiornamenti.
- Per ogni nuova versione: aggiorna `CHANGELOG.md`, `npm run build`, poi **Publish new version** dallo stesso menu con una breve nota delle modifiche.
