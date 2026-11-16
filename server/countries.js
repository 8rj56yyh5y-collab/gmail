'use strict';
// Страны → язык письма. Распознаёт страну, как бы её ни написали в файле:
// «Germany», «Deutschland», «Германия», «Німеччина», «DE», «DEU»; если страны нет — по домену почты (.de, .fr…).

// [ISO, язык, русское название, ISO3, английское, родное, ...другие варианты]
const LIST = [
  ['DE', 'de', 'Германия', 'DEU', 'Germany', 'Deutschland', 'Німеччина', 'Allemagne', 'Alemania', 'Germania', 'Niemcy'],
  ['AT', 'de', 'Австрия', 'AUT', 'Austria', 'Österreich', 'Oesterreich', 'Австрія', 'Autriche'],
  ['CH', 'de', 'Швейцария', 'CHE', 'Switzerland', 'Schweiz', 'Suisse', 'Svizzera', 'Швейцарія', 'Suiza'],
  ['LI', 'de', 'Лихтенштейн', 'LIE', 'Liechtenstein'],
  ['LU', 'fr', 'Люксембург', 'LUX', 'Luxembourg', 'Luxemburg', 'Люксембург'],
  ['FR', 'fr', 'Франция', 'FRA', 'France', 'Франція', 'Frankreich', 'Francia', 'Francja'],
  ['BE', 'fr', 'Бельгия', 'BEL', 'Belgium', 'Belgique', 'België', 'Belgie', 'Belgien', 'Бельгія', 'Bélgica'],
  ['MC', 'fr', 'Монако', 'MCO', 'Monaco'],
  ['ES', 'es', 'Испания', 'ESP', 'Spain', 'España', 'Espana', 'Іспанія', 'Spanien', 'Espagne', 'Hiszpania', 'Spagna'],
  ['IT', 'it', 'Италия', 'ITA', 'Italy', 'Italia', 'Італія', 'Italien', 'Italie', 'Włochy'],
  ['SM', 'it', 'Сан-Марино', 'SMR', 'San Marino'],
  ['PT', 'pt', 'Португалия', 'PRT', 'Portugal', 'Португалія'],
  ['NL', 'nl', 'Нидерланды', 'NLD', 'Netherlands', 'Nederland', 'Holland', 'Голландия', 'Нідерланди', 'Голландія', 'The Netherlands', 'Niederlande', 'Pays-Bas', 'Países Bajos'],
  ['GB', 'en', 'Великобритания', 'GBR', 'United Kingdom', 'UK', 'Great Britain', 'England', 'Scotland', 'Wales', 'Британия', 'Англия', 'Велика Британія', 'Англія'],
  ['IE', 'en', 'Ирландия', 'IRL', 'Ireland', 'Éire', 'Ірландія'],
  ['MT', 'en', 'Мальта', 'MLT', 'Malta'],
  ['PL', 'pl', 'Польша', 'POL', 'Poland', 'Polska', 'Польща', 'Polen', 'Pologne'],
  ['CZ', 'cs', 'Чехия', 'CZE', 'Czech Republic', 'Czechia', 'Česko', 'Česká republika', 'Чехія', 'Tschechien'],
  ['SK', 'sk', 'Словакия', 'SVK', 'Slovakia', 'Slovensko', 'Словаччина', 'Slowakei'],
  ['HU', 'hu', 'Венгрия', 'HUN', 'Hungary', 'Magyarország', 'Угорщина', 'Ungarn'],
  ['RO', 'ro', 'Румыния', 'ROU', 'Romania', 'România', 'Румунія', 'Rumänien'],
  ['MD', 'ro', 'Молдова', 'MDA', 'Moldova', 'Молдавия'],
  ['BG', 'bg', 'Болгария', 'BGR', 'Bulgaria', 'България', 'Болгарія', 'Bulgarien'],
  ['HR', 'hr', 'Хорватия', 'HRV', 'Croatia', 'Hrvatska', 'Хорватія', 'Kroatien'],
  ['SI', 'sl', 'Словения', 'SVN', 'Slovenia', 'Slovenija', 'Словенія', 'Slowenien'],
  ['RS', 'sr', 'Сербия', 'SRB', 'Serbia', 'Srbija', 'Сербія', 'Serbien'],
  ['BA', 'hr', 'Босния и Герцеговина', 'BIH', 'Bosnia and Herzegovina', 'Bosnia', 'Босния'],
  ['ME', 'sr', 'Черногория', 'MNE', 'Montenegro', 'Crna Gora'],
  ['MK', 'en', 'Северная Македония', 'MKD', 'North Macedonia', 'Macedonia', 'Македония'],
  ['AL', 'en', 'Албания', 'ALB', 'Albania'],
  ['GR', 'el', 'Греция', 'GRC', 'Greece', 'Ελλάδα', 'Hellas', 'Греція', 'Griechenland'],
  ['CY', 'el', 'Кипр', 'CYP', 'Cyprus', 'Κύπρος', 'Кіпр'],
  ['SE', 'sv', 'Швеция', 'SWE', 'Sweden', 'Sverige', 'Швеція', 'Schweden'],
  ['NO', 'no', 'Норвегия', 'NOR', 'Norway', 'Norge', 'Норвегія', 'Norwegen'],
  ['DK', 'da', 'Дания', 'DNK', 'Denmark', 'Danmark', 'Данія', 'Dänemark'],
  ['FI', 'fi', 'Финляндия', 'FIN', 'Finland', 'Suomi', 'Фінляндія', 'Finnland'],
  ['IS', 'en', 'Исландия', 'ISL', 'Iceland', 'Ísland'],
  ['EE', 'et', 'Эстония', 'EST', 'Estonia', 'Eesti', 'Естонія'],
  ['LV', 'lv', 'Латвия', 'LVA', 'Latvia', 'Latvija', 'Латвія'],
  ['LT', 'lt', 'Литва', 'LTU', 'Lithuania', 'Lietuva'],
  ['UA', 'uk', 'Украина', 'UKR', 'Ukraine', 'Україна'],
  ['TR', 'tr', 'Турция', 'TUR', 'Turkey', 'Türkiye', 'Turkiye', 'Туреччина'],
  ['US', 'en', 'США', 'USA', 'United States', 'United States of America', 'America', 'Америка', 'Сполучені Штати'],
  ['CA', 'en', 'Канада', 'CAN', 'Canada'],
  ['AU', 'en', 'Австралия', 'AUS', 'Australia'],
  ['IL', 'en', 'Израиль', 'ISR', 'Israel'],
  ['AE', 'en', 'ОАЭ', 'ARE', 'United Arab Emirates', 'UAE', 'Emirates'],
  ['MX', 'es', 'Мексика', 'MEX', 'Mexico', 'México'],
  ['AR', 'es', 'Аргентина', 'ARG', 'Argentina'],
  ['BR', 'pt', 'Бразилия', 'BRA', 'Brazil', 'Brasil'],
  ['JP', 'en', 'Япония', 'JPN', 'Japan'],
  ['CN', 'en', 'Китай', 'CHN', 'China'],
  ['KR', 'en', 'Южная Корея', 'KOR', 'South Korea', 'Korea'],
];

// Языки, которые понимает система. Шаблон может быть не на каждом — тогда письмо уйдёт на запасном (обычно английском).
const LANGS = {
  en: 'Английский', de: 'Немецкий', fr: 'Французский', es: 'Испанский', it: 'Итальянский', pt: 'Португальский',
  nl: 'Нидерландский', pl: 'Польский', cs: 'Чешский', sk: 'Словацкий', hu: 'Венгерский', ro: 'Румынский',
  bg: 'Болгарский', hr: 'Хорватский', sl: 'Словенский', sr: 'Сербский', el: 'Греческий', sv: 'Шведский',
  no: 'Норвежский', da: 'Датский', fi: 'Финский', et: 'Эстонский', lv: 'Латышский', lt: 'Литовский',
  uk: 'Украинский', tr: 'Турецкий', ru: 'Русский',
};
// Как пользователь может указать язык в файле
const LANG_ALIASES = {
  en: ['english', 'eng', 'английский', 'англ', 'англійська'], de: ['german', 'deutsch', 'ger', 'немецкий', 'нем', 'німецька'],
  fr: ['french', 'français', 'francais', 'fra', 'французский', 'франц', 'французька'], es: ['spanish', 'español', 'espanol', 'spa', 'испанский', 'исп', 'іспанська'],
  it: ['italian', 'italiano', 'ita', 'итальянский', 'італійська'], pt: ['portuguese', 'português', 'португальский'],
  nl: ['dutch', 'nederlands', 'голландский', 'нидерландский'], pl: ['polish', 'polski', 'польский', 'польська'],
  cs: ['czech', 'čeština', 'чешский'], ro: ['romanian', 'română', 'румынский'], uk: ['ukrainian', 'українська', 'украинский'],
  ru: ['russian', 'русский', 'російська'], sv: ['swedish', 'svenska', 'шведский'], el: ['greek', 'греческий'], tr: ['turkish', 'турецкий'],
};

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const BY_KEY = new Map();
const BY_CODE = new Map();
for (const [code, lang, ru, iso3, ...names] of LIST) {
  BY_CODE.set(code, { code, lang, name: ru });
  for (const n of [code, iso3, ru, ...names]) BY_KEY.set(norm(n), code);
}
BY_KEY.set('uk', 'GB'); // в файлах «UK» почти всегда Великобритания, не Украина

// Домены верхнего уровня → страна (если в файле страна не указана)
const TLD = { de: 'DE', at: 'AT', ch: 'CH', li: 'LI', lu: 'LU', fr: 'FR', be: 'BE', mc: 'MC', es: 'ES', cat: 'ES', it: 'IT', pt: 'PT', nl: 'NL',
  uk: 'GB', ie: 'IE', mt: 'MT', pl: 'PL', cz: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO', md: 'MD', bg: 'BG', hr: 'HR', si: 'SI', rs: 'RS', ba: 'BA', me: 'ME',
  gr: 'GR', cy: 'CY', se: 'SE', no: 'NO', dk: 'DK', fi: 'FI', is: 'IS', ee: 'EE', lv: 'LV', lt: 'LT', ua: 'UA', tr: 'TR', mx: 'MX', ar: 'AR', br: 'BR',
  ca: 'CA', au: 'AU', il: 'IL', ae: 'AE', jp: 'JP', cn: 'CN', kr: 'KR' };

function findCountry(raw) {
  const k = norm(raw);
  if (!k) return '';
  if (BY_KEY.has(k)) return BY_KEY.get(k);
  // «Berlin, Germany», «Germany (Bavaria)» — ищем название страны внутри строки
  const words = k.split(' ');
  for (let len = Math.min(4, words.length); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const part = words.slice(i, i + len).join(' ');
      if (part.length >= 3 && BY_KEY.has(part)) return BY_KEY.get(part);
    }
  }
  return '';
}
function countryFromEmail(email) {
  const tld = String(email || '').toLowerCase().split('.').pop();
  return TLD[tld] || '';
}
function findLang(raw) {
  const k = norm(raw);
  if (!k) return '';
  if (LANGS[k]) return k;
  for (const [code, list] of Object.entries(LANG_ALIASES)) if (list.some((a) => norm(a) === k)) return code;
  return '';
}
const langOf = (code) => (BY_CODE.get(code) || {}).lang || '';
const countryName = (code) => (BY_CODE.get(code) || {}).name || code || '';
const flag = (code) => (/^[A-Z]{2}$/.test(code || '') ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
const countries = () => [...BY_CODE.values()].map((c) => ({ ...c, flag: flag(c.code) }));

module.exports = { LANGS, findCountry, countryFromEmail, findLang, langOf, countryName, flag, countries };
