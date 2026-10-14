const tutorials = [...document.querySelectorAll('.example-card')];
const search = document.querySelector('#search');
search.addEventListener('input', () => {
  const query = search.value.trim().toLocaleLowerCase();
  let count = 0;
  for (const tutorial of tutorials) {
    tutorial.hidden = !tutorial.textContent.toLocaleLowerCase().includes(query);
    if (!tutorial.hidden) count++;
  }
  document.querySelector('#result-count').textContent = `${count} ${count === 1 ? 'tutorial' : 'tutorials'}`;
  document.querySelector('#empty').hidden = count > 0;
});
