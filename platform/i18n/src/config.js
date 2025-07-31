const debugMode = !!(process.env.NODE_ENV !== 'production' && process.env.REACT_APP_I18N_DEBUG);

const detectionOptions = {
  // order and from where user language should be detected
  // Removed 'navigator' to disable system language detection
  // Removed 'htmlTag' to avoid HTML lang attribute detection
  order: ['querystring', 'cookie', 'localStorage'],

  // keys or params to lookup language from
  lookupQuerystring: 'lng',
  lookupCookie: 'i18next',
  lookupLocalStorage: 'i18nextLng',
  lookupFromPathIndex: 0,
  lookupFromSubdomainIndex: 0,

  // cache user language on
  caches: ['localStorage', 'cookie'],
  excludeCacheFor: ['cimode'], // languages to not persist (cookie, localStorage)

  // optional htmlTag with lang attribute, the default is:
  htmlTag: document.documentElement,
};

export { debugMode, detectionOptions };
