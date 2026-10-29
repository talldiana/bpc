// UI-02: English or German, chosen from the browser language.
export function languageOf(request) {
  return (request.headers.get('Accept-Language') ?? '').toLowerCase().startsWith('de') ? 'de' : 'en';
}
