window.PB_BRAND = Object.freeze({
  name: 'The Quadrant',
  legalName: 'The Quadrant',
  shortName: 'Quadrant',
  uppercaseName: 'THE QUADRANT',
  tagline: 'Pickleball Court Booking',
  location: 'Dauman, Montevista',
  address: 'Dauman, Montevista, Philippines, 8801',
  mapUrl: 'https://www.bing.com/maps/default.aspx?v=2&pc=FACEBK&mid=8100&where1=Dauman%2C%20Montevista%2C%20Philippines%2C%208801&FORM=FBKPL1&mkt=en-US',
  logo: 'the-quadrant-logo.jpg',
  domain: '',
  adminEmail: 'owner@thequadrant.local',
  paymentMerchantName: 'The Quadrant',
});

window.pbBrandValue = function pbBrandValue(key, fallback = '') {
  return (window.PB_BRAND && window.PB_BRAND[key]) || fallback;
};
