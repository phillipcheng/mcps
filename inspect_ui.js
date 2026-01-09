const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1600,1000']
  });
  const page = await browser.newPage();
  
  try {
    await page.setViewport({ width: 1600, height: 1000 });

    console.log('Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle0', timeout: 30000 });

    // Navigate to Symptom -> Internal -> Data Sync
    await page.waitForSelector('.tab-header .tab-button', { timeout: 10000 });
    const symptomTab = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button.tab-button'));
        return buttons.find(b => b.textContent.includes('Symptom Analysis'));
    });
    if (symptomTab) await symptomTab.click();
    await new Promise(r => setTimeout(r, 2000));

    // L1
    const l1Clicked = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.subcategory-card'));
        const target = cards.find(card => card.textContent.includes('内部系统') || card.textContent.includes('Internal'));
        if (target) { target.click(); return true; }
        return false;
    });
    if (!l1Clicked) throw new Error('L1 not found');
    await new Promise(r => setTimeout(r, 2000));

    // L2
    const l2Clicked = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.subcategory-card'));
        const target = cards.find(card => card.textContent.includes('数据同步') || card.textContent.includes('Data Sync'));
        if (target) { target.click(); return true; }
        return false;
    });
    if (!l2Clicked) throw new Error('L2 not found');
    await new Promise(r => setTimeout(r, 2000));

    // Inspect Group ID Tag
    console.log('Inspecting Group ID Tag...');
    const tagInfo = await page.evaluate(() => {
        const tag = document.querySelector('.group-id-tag');
        if (!tag) return null;
        const style = window.getComputedStyle(tag);
        return {
            text: tag.textContent,
            color: style.color,
            backgroundColor: style.backgroundColor,
            display: style.display,
            fontSize: style.fontSize
        };
    });

    console.log('Tag Info:', JSON.stringify(tagInfo, null, 2));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
})();