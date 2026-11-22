document.addEventListener('click', function (e) {
  if (!e.target.closest('.ts-wish')) return;
  fetch('/wp-json/tangled/v1/wishlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: ['mug'] })
  });
});

// Legacy fallback for old themes: the action is only visible in the FormData.
function tsLegacySync() {
  var fd = new FormData();
  fd.append('action', 'ts_add_to_cart');
  fd.append('sku', 'mug');
  var xhr = new XMLHttpRequest();
  xhr.open('POST', window.tsCart.ajaxUrl);
  xhr.send(fd);
}
