import 'dotenv/config';
process.env.SHOPEE_DEBUG='1';
import { ShopeeOAuthService } from './app/marketplaces/services/shopee-oauth.service';
const res = ShopeeOAuthService.initiateAuth();
console.log('authUrl', res.auth_url);
