import { createElement } from './utils.js';

/**
 * A small menu hanging under a header button. It lives in <body> (outside the sidebar, which clips), is closed by a
 * click anywhere else (see `contains`) and re-renders its content each time it opens.
 *   render(list)   fills the given container
 */
export const createPopover = ({ button, render, className = "" }) => {
  const element = createElement("div", {
    className: `assets-plus-context-menu assets-plus-popover ${className}`.trim(),
  });
  const list = createElement("div", { className: "assets-plus-context-menu-list" });
  element.appendChild(list);
  document.body.appendChild(element);

  // Our own menu: the browser's Copy / Select All menu has no business in it.
  element.addEventListener("contextmenu", (event) => event.preventDefault());

  const isOpen = () => element.classList.contains("open");

  const place = () => {
    const rect = button.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8));
    const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - box.height - 8));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  };

  const close = () => {
    element.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
  };

  const onKeydown = (event) => {
    if (event.key === "Escape" && isOpen()) {
      event.stopPropagation();
      close();
      button.focus?.();
    }
  };
  document.addEventListener("keydown", onKeydown, true);

  const open = () => {
    render(list);
    element.style.visibility = "hidden";
    element.classList.add("open");
    place();
    element.style.visibility = "";
    button.setAttribute("aria-expanded", "true");
  };

  return {
    element,
    isOpen,
    open,
    close,
    toggle: () => (isOpen() ? close() : open()),
    /** Redraw the open menu in place (state changed under it). */
    refresh: () => {
      if (!isOpen()) return;
      render(list);
      place();
    },
    contains: (target) => element.contains(target) || button.contains(target),
    destroy: () => {
      document.removeEventListener("keydown", onKeydown, true);
      element.remove();
    },
  };
};
