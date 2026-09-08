import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { Overlay } from './Overlay.js'
import './styles.css'

// One bundle, two entry points. The fullscreen chat overlay is a second window
// loading the same file with #overlay, which keeps the build to a single
// renderer and the two views sharing their types and formatting.
const isOverlay = window.location.hash === '#overlay'

// The overlay window paints over a film, so its page must not paint a
// background of its own -- the app's gradient would fill the whole video.
if (isOverlay) document.body.classList.add('overlay-body')

createRoot(document.getElementById('root')!).render(isOverlay ? <Overlay /> : <App />)
