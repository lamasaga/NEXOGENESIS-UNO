try {
  document.documentElement.dataset.theme = localStorage.getItem("uno:appearance:v1") === "warm-white"
    ? "warm-white" : "dark-blue";
} catch {
  document.documentElement.dataset.theme = "dark-blue";
}
