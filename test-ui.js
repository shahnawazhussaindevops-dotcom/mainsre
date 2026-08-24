import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
  
  console.log('Navigating to http://localhost:4478...');
  await page.goto('http://localhost:4478', { waitUntil: 'networkidle0' });
  console.log('Page loaded');
  
  const serverListHTML = await page.$eval('#serverList', el => el.innerHTML);
  console.log('Server list HTML length:', serverListHTML.length);
  
  await browser.close();
})();
