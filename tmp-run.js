require('ts-node/register');
require('dotenv').config();
process.env.SHOPEE_DEBUG='1';
const { ShopeeOAuthService } = require('./app/marketplaces/services/shopee-oauth.service');
const res = ShopeeOAuthService.initiateAuth();
console.log('authUrl', res.auth_url);
