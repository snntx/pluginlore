jQuery(function ($) {
  $('#ts-add').on('click', function () {
    $.post(tsCart.ajaxUrl, { action: 'ts_add_to_cart', nonce: tsCart.nonce, sku: $(this).data('sku'), qty: 1 })
      .done(function (res) {
        $('#ts-cart').find('.ts-count').text(res.data.count);
      });
  });
});
