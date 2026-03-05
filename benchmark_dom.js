import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  await page.evaluate(() => {
    const NUM_ITEMS = 1000;
    const ITERATIONS = 100;
    const games = Array.from({ length: NUM_ITEMS }, (_, i) => ({ id: i, name: 'Game ' + i }));

    function buildGameCard(game) {
      const card = document.createElement('div');
      card.className = 'game-card';
      const icon = document.createElement('div');
      icon.className = 'game-card__icon';
      icon.textContent = 'icon';
      const info = document.createElement('div');
      info.className = 'game-card__info';
      info.textContent = game.name;
      card.appendChild(icon);
      card.appendChild(info);
      return card;
    }

    const grid = document.createElement('div');
    document.body.appendChild(grid);

    window.testBaseline = function() {
      const times = [];
      for (let j = 0; j < 5; j++) {
        grid.innerHTML = '';
        for (const game of games) {
          grid.appendChild(buildGameCard(game));
        }
      }
      for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now();
        grid.innerHTML = '';
        for (const game of games) {
          grid.appendChild(buildGameCard(game));
        }
        // Force reflow
        grid.offsetHeight;
        times.push(performance.now() - start);
      }
      const sum = times.reduce((a, b) => a + b, 0);
      return { avg: sum / ITERATIONS, total: sum };
    };

    window.testOptimized = function() {
      const times = [];
      for (let j = 0; j < 5; j++) {
        grid.innerHTML = '';
        const fragment = document.createDocumentFragment();
        for (const game of games) {
          fragment.appendChild(buildGameCard(game));
        }
        grid.appendChild(fragment);
      }
      for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now();
        grid.innerHTML = '';
        const fragment = document.createDocumentFragment();
        for (const game of games) {
          fragment.appendChild(buildGameCard(game));
        }
        grid.appendChild(fragment);
        // Force reflow
        grid.offsetHeight;
        times.push(performance.now() - start);
      }
      const sum = times.reduce((a, b) => a + b, 0);
      return { avg: sum / ITERATIONS, total: sum };
    };
  });

  const baseStats = await page.evaluate(() => window.testBaseline());
  const optStats = await page.evaluate(() => window.testOptimized());

  console.log('=== Baseline ===');
  console.log('Average time:', baseStats.avg.toFixed(3), 'ms');
  console.log('Total time:', baseStats.total.toFixed(3), 'ms');

  console.log('\n=== Optimized ===');
  console.log('Average time:', optStats.avg.toFixed(3), 'ms');
  console.log('Total time:', optStats.total.toFixed(3), 'ms');

  console.log('\nImprovement:', ((baseStats.avg - optStats.avg) / baseStats.avg * 100).toFixed(2), '% faster');

  await browser.close();
})();
