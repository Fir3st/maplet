const cards = [...document.querySelectorAll('.example-card')];
const search = document.querySelector('#search');
const filters = [...document.querySelectorAll('[data-filter]')];
let group = 'All examples';
function update() {
  const query = search.value.trim().toLocaleLowerCase();
  let count = 0;
  for (const card of cards) {
    const visible = (group === 'All examples' || card.dataset.group === group) && card.textContent.toLocaleLowerCase().includes(query);
    card.hidden = !visible;
    if (visible) count++;
  }
  document.querySelector('#result-count').textContent = `${count} ${count === 1 ? 'example' : 'examples'}`;
  document.querySelector('#empty').hidden = count > 0;
}
search.addEventListener('input', update);
for (const button of filters) button.addEventListener('click', () => {
  group = button.dataset.filter;
  for (const filter of filters) filter.setAttribute('aria-pressed', String(filter === button));
  update();
});
fetch('./gists.json')
  .then(response => { if (!response.ok) throw new Error('Gist links unavailable'); return response.json(); })
  .then(links => {
    for (const link of document.querySelectorAll('[data-gist]')) {
      const url = links[link.dataset.gist];
      if (!url || !/^https:\/\/gist\.github\.com\/[A-Za-z0-9-]+\/[0-9a-f]+$/.test(url)) continue;
      link.href = url; link.textContent = 'Source Gist ↗'; link.classList.remove('gist-pending'); link.removeAttribute('aria-disabled');
    }
  })
  .catch(() => { for (const link of document.querySelectorAll('[data-gist]')) link.textContent = 'Gist links unavailable'; });
