// SCRUM-104: loads Clerk (sign-in, sign-up, sign-out) in the browser.
// The publishable key comes from the Worker (/api/config), so the same pages
// work with a test and a live Clerk instance. Usage: const clerk = await loadClerk();

function addScript(src, attributes = {}) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.crossOrigin = 'anonymous';
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });
}

window.loadClerk = async function loadClerk() {
  const { clerkPublishableKey: key } = await fetch('/api/config').then((response) => response.json());
  // The publishable key encodes Clerk's frontend API host: pk_test_<base64 "host$">.
  const host = atob(key.split('_')[2]).replace(/\$$/, '');
  await addScript(`https://${host}/npm/@clerk/ui@1/dist/ui.browser.js`);
  await addScript(`https://${host}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, { 'data-clerk-publishable-key': key });
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  return window.Clerk;
};
