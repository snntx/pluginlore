// front-end script for the sample plugin
jQuery(function ($) {
  $('#save').on('click', function () {
    $.ajax({
      url: ajaxurl,
      method: 'POST',
      data: { action: 'sample_save', id: 5, name: 'x' }
    });
  });

  fetch('/wp-json/sample/v1/item', {
    method: 'POST',
    body: JSON.stringify({ id: 1 })
  }).then(r => r.json());

  wp.apiFetch({ path: 'sample/v1/item', method: 'POST' });
});
