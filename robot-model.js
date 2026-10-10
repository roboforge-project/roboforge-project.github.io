import './assets/vendor/model-viewer/model-viewer.min.js';

const viewer = document.querySelector('#robot-model');
const status = document.querySelector('#model-status');
const reset = document.querySelector('#model-reset');
const initialOrbit = viewer.getAttribute('camera-orbit');

viewer.addEventListener('load', () => {
  status.hidden = true;
  reset.disabled = false;
});

viewer.addEventListener('error', () => {
  status.textContent = '3D model unavailable. Showing the assembly preview.';
  status.hidden = false;
  reset.disabled = true;
});

reset.addEventListener('click', () => {
  viewer.cameraOrbit = initialOrbit;
  viewer.cameraTarget = 'auto auto auto';
  viewer.fieldOfView = 'auto';
  viewer.jumpCameraToGoal();
});
