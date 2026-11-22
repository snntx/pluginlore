document.getElementById('tn-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var body = new URLSearchParams({ action: 'tn_subscribe', email: this.email.value, _wpnonce: window.tnSignup.nonce });
  fetch(window.tnSignup.ajaxUrl, { method: 'POST', body: body });
});
