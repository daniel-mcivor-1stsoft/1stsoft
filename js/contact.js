/* 1st Soft — contact form */

(function () {
  const form = document.getElementById('contact-form');
  if (!form) return;

  const status = document.getElementById('form-status');
  const submitBtn = form.querySelector('.form-submit');

  function showError(input, msg) {
    input.classList.add('invalid');
    const err = document.getElementById(input.id + '-error');
    if (err) { err.textContent = msg; err.classList.add('visible'); }
  }

  function clearError(input) {
    input.classList.remove('invalid');
    const err = document.getElementById(input.id + '-error');
    if (err) err.classList.remove('visible');
  }

  function validateEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  function validate() {
    let ok = true;
    const name = form.querySelector('#name');
    const email = form.querySelector('#email');
    const message = form.querySelector('#message');

    clearError(name); clearError(email); clearError(message);

    if (!name.value.trim()) { showError(name, 'Please enter your name.'); ok = false; }
    if (!email.value.trim()) { showError(email, 'Please enter your email address.'); ok = false; }
    else if (!validateEmail(email.value.trim())) { showError(email, 'Please enter a valid email address.'); ok = false; }
    if (!message.value.trim()) { showError(message, 'Please enter a message.'); ok = false; }

    return ok;
  }

  // Inline validation on blur
  ['name', 'email', 'message'].forEach(function (id) {
    const el = form.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('blur', function () {
      if (!el.value.trim()) {
        const labels = { name: 'Please enter your name.', email: 'Please enter your email address.', message: 'Please enter a message.' };
        showError(el, labels[id]);
      } else if (id === 'email' && !validateEmail(el.value.trim())) {
        showError(el, 'Please enter a valid email address.');
      } else {
        clearError(el);
      }
    });
    el.addEventListener('input', function () { clearError(el); });
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!validate()) return;

    status.className = 'form-status';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    const payload = {
      name: form.querySelector('#name').value.trim(),
      email: form.querySelector('#email').value.trim(),
      phone: form.querySelector('#phone').value.trim(),
      message: form.querySelector('#message').value.trim(),
      hp: form.querySelector('#website').value // honeypot
    };

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        status.className = 'form-status success';
        status.innerHTML = '<span aria-hidden="true">✓</span> Message sent — we\'ll be in touch shortly.';
        form.reset();
      } else {
        throw new Error('non-2xx');
      }
    } catch (_) {
      status.className = 'form-status error';
      status.innerHTML = '<span aria-hidden="true">!</span> Couldn\'t send your message — please try again or email us directly at <a href="mailto:hello@1stsoft.co.uk">hello@1stsoft.co.uk</a>.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send message';
      status.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
})();
