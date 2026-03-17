const axios=require("axios");const crypto=require("crypto");
const partnerId=1222187;const apiPath="/api/v2/shop/auth_partner";const timestamp=Math.floor(Date.now()/1000);const redirect="https://2dab-152-234-122-51.ngrok-free.app/marketplace/shopee/callback";const encoded=encodeURIComponent(redirect);
const keys=["shpk6c48476959454c6e4365434a6877704e4d6b61576549467366516e6e595a","6c48476959454c6e4365434a6877704e4d6b61576549467366516e6e595a"];
const formulas={
 hmac:(k,b)=>crypto.createHmac("sha256",k).update(b).digest("hex"),
 sha:(k,b)=>crypto.createHash("sha256").update(b+k).digest("hex"),
 shabefore:(k,b)=>crypto.createHash("sha256").update(k+b).digest("hex"),
 hmacHex:(k,b)=>crypto.createHmac("sha256", Buffer.from(k,"hex")).update(b).digest("hex"),
};
const bases=[partnerId+apiPath+timestamp, partnerId+apiPath+timestamp+redirect, partnerId+apiPath+timestamp+encoded];
(async()=>{for(const key of keys){for(const [fname,f] of Object.entries(formulas)){for(const base of bases){const sig=f(key,base);const url=`https://partner.test-stable.shopeemobile.com${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sig}&redirect=${encoded}`;const r=await axios.get(url,{validateStatus:()=>true});const ok=r.status===200;console.log(key.length,fname,base.length,ok?'OK':'FAIL',r.status,r.data.error||r.data.message||r.data);}}}
})();
