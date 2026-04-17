// Google Ads conversion tracking — Stephens Advanced LLC
// -----------------------------------------------------------------------------
// TODO: After creating each conversion action in Google Ads (Goals → Summary →
// + New conversion action), paste the full send_to value below. The format is:
//   AW-XXXXXXXXX/AbCdEfGhIjKlMn
// You get it from Google Ads after saving the conversion action — it's the
// "TAG_ID/CONVERSION_LABEL" shown in the event snippet Google gives you.
//
// Until these are filled in, the helpers below are no-ops (no errors, no
// accidental reporting, no token burn).
// -----------------------------------------------------------------------------
window.GA_CONV = {
  FORM_SUBMIT: '', // Goal: Submit lead form  (Request Service, Apply, Pay with Square)
  PHONE_WEB:   '', // Goal: Calls from a website  (tel: link taps on the site)
  PHONE_ADS:   ''  // Goal: Calls from ads  (optional — only for Google Ads call assets)
};

// Fires a form-submit conversion. If a URL is passed, redirects after the
// conversion beacon fires (or immediately if no tag is configured).
function gtag_report_conversion(url) {
  var hasTag = window.GA_CONV && window.GA_CONV.FORM_SUBMIT;
  var callback = function () {
    if (typeof url !== 'undefined' && url) window.location = url;
  };
  if (hasTag && typeof gtag === 'function') {
    gtag('event', 'conversion', {
      'send_to': window.GA_CONV.FORM_SUBMIT,
      'event_callback': callback
    });
  } else {
    // No tag configured — just run the callback so the UX still works
    callback();
  }
  return false;
}

// Fires a phone-tap conversion when a tel: link is clicked. Returns true so
// the default <a href="tel:..."> behavior still runs.
function gtag_report_phone_tap() {
  if (window.GA_CONV && window.GA_CONV.PHONE_WEB && typeof gtag === 'function') {
    gtag('event', 'conversion', { 'send_to': window.GA_CONV.PHONE_WEB });
  }
  return true;
}

// Phone forwarding: dynamically swaps the on-page phone number with a Google
// Forwarding Number for visitors arriving from ads, so Google can track which
// ad click led to the phone call.
if (window.GA_CONV && window.GA_CONV.PHONE_WEB && typeof gtag === 'function') {
  var tagId = window.GA_CONV.PHONE_WEB.split('/')[0];
  gtag('config', tagId, { 'phone_conversion_number': '(214) 994-4799' });
}
