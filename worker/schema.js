// What the panel can change. Each key matches a data-cms attribute in index.html.
// Types: text (one line), textarea (a paragraph), phone, email, usd (whole dollars), image.

const SERVICE_COUNT = 6;

function serviceFields(i) {
  const k = 'svc' + i;
  return [
    { key: k + '_name', type: 'text', max: 40, sr: 'Naziv usluge', en: 'Service name' },
    { key: k + '_desc', type: 'textarea', max: 260, sr: 'Opis', en: 'Description' },
    { key: k + '_price', type: 'usd', sr: 'Cena ($)', en: 'Price ($)' },
    { key: k + '_mem', type: 'usd', read: { from: k + '_price', attr: 'data-mem' },
      sr: 'Cena za članove kluba ($)', en: 'Comfort Club member price ($)' },
    { key: k + '_note', type: 'text', max: 50, sr: 'Napomena uz cenu', en: 'Note under the price' },
  ];
}

export const GROUPS = [
  {
    id: 'hero', sr: 'Vrh stranice', en: 'Top of the page',
    fields: [
      { key: 'hero_title_1', type: 'text', max: 70, sr: 'Naslov', en: 'Headline' },
      { key: 'hero_title_2', type: 'text', max: 16, sr: 'Istaknuti kraj naslova (plavo)', en: 'Highlighted end of the headline (blue)' },
      { key: 'hero_lead', type: 'textarea', max: 260, sr: 'Tekst ispod naslova', en: 'Text under the headline' },
      { key: 'hero_image', type: 'image', sr: 'Velika slika u pozadini', en: 'Background photo' },
    ],
  },
  {
    id: 'contact', sr: 'Kontakt', en: 'Contact',
    fields: [
      { key: 'phone', type: 'phone', max: 25, sr: 'Telefon', en: 'Phone number' },
      { key: 'email', type: 'email', max: 80, sr: 'Email', en: 'Email' },
      { key: 'hours', type: 'text', max: 60, sr: 'Radno vreme', en: 'Office hours' },
    ],
  },
  {
    id: 'services', sr: 'Usluge i cene', en: 'Services & prices',
    items: Array.from({ length: SERVICE_COUNT }, (_, n) => ({
      sr: 'Usluga ' + (n + 1), en: 'Service ' + (n + 1), fields: serviceFields(n + 1),
    })),
  },
  {
    id: 'club', sr: 'Comfort Club', en: 'Comfort Club',
    fields: [
      { key: 'club_price', type: 'usd', sr: 'Mesečna cena ($)', en: 'Monthly price ($)' },
      { key: 'club_perk1', type: 'text', max: 70, sr: 'Pogodnost 1', en: 'Perk 1' },
      { key: 'club_perk2', type: 'text', max: 70, sr: 'Pogodnost 2', en: 'Perk 2' },
      { key: 'club_perk3', type: 'text', max: 70, sr: 'Pogodnost 3', en: 'Perk 3' },
      { key: 'club_perk4', type: 'text', max: 70, sr: 'Pogodnost 4', en: 'Perk 4' },
    ],
  },
];

export const FIELDS = {};
for (const g of GROUPS) {
  for (const f of g.fields || []) FIELDS[f.key] = f;
  for (const item of g.items || []) for (const f of item.fields) FIELDS[f.key] = f;
}

const PHONE_RE = /^[0-9 ()+.\-]{7,25}$/;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const MEDIA_RE = /^\/media\/[a-f0-9]{24}\.(webp|jpg|png)$/;

// Returns { value } with the cleaned value, { value: null } to go back to the original, or { error }.
export function clean(key, raw) {
  const f = FIELDS[key];
  if (!f) return { error: 'unknown field' };
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'bad value' };
  let v = String(raw).replace(/\s+/g, ' ').trim();
  if (v === '') return { value: null };
  switch (f.type) {
    case 'usd': {
      v = v.replace(/[$,\s]/g, '');
      if (!/^\d{1,5}$/.test(v)) return { error: 'price' };
      return { value: String(parseInt(v, 10)) };
    }
    case 'phone':
      return PHONE_RE.test(v) ? { value: v } : { error: 'phone' };
    case 'email':
      return EMAIL_RE.test(v) && v.length <= f.max ? { value: v } : { error: 'email' };
    case 'image':
      return MEDIA_RE.test(v) ? { value: v } : { error: 'image' };
    default:
      if (v.length > f.max) return { error: 'too long' };
      // Notes also live in an HTML attribute, so straight double quotes become typographic ones.
      return { value: v.replace(/"/g, '”') };
  }
}
