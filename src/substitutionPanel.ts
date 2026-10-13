export interface SubstitutionCallbacks{
    onApply : (alphaRad : number, iterations : number) => void; 
    onReset : () => void; 
}

export interface SubstitutionPanel { 
    toggle : () => void; 
    setStats : (text : string) => void; 
}

export function createSubstitutionPanel (cb: SubstitutionCallbacks) : SubstitutionPanel {
    const panel = document.createElement("div");
    panel.className = "sub-panel";
  panel.style.display = "block";

  // header + close button
  const header = document.createElement("div");
  header.className = "sub-header";
  const title = document.createElement("h3");
  title.textContent = "T-bar substitution";
  const close = document.createElement("button");
  close.textContent = "×";
  close.onclick = () => (panel.style.display = "none");
  header.append(title, close);

  // α slider
  const alphaLabel = document.createElement("label");
  const alphaInput = document.createElement("input");
  alphaInput.type = "range";
  alphaInput.min = "5";
  alphaInput.max = "45";
  alphaInput.value = "20";
  const showAlpha = () => (alphaLabel.textContent = `α = ${alphaInput.value}°`);
  alphaInput.oninput = showAlpha;
  showAlpha();

  // iterations
  const nLabel = document.createElement("label");
  nLabel.textContent = "iterations n";
  const nInput = document.createElement("input");
  nInput.type = "number";
  nInput.min = "1";
  nInput.max = "3";
  nInput.value = "1";

  // buttons
  const apply = document.createElement("button");
  apply.textContent = "Apply";
  apply.onclick = () => {
    const alpha = (Number(alphaInput.value) * Math.PI) / 180;
    cb.onApply(alpha, Number(nInput.value));
  };
  const reset = document.createElement("button");
  reset.textContent = "Reset";
  reset.onclick = cb.onReset;

  // readout
  const stats = document.createElement("pre");
  stats.className = "sub-stats";
   // μ chart
  const chart = document.createElement("canvas");
  chart.width = 216;
  chart.height = 90;
  const ctx = chart.getContext("2d")!;

  const drawChart = () => {
    const alpha = (Number(alphaInput.value) * Math.PI) / 180;
    const nSel = Number(nInput.value);
    const t = Math.tan(alpha) ** 2.5;
    ctx.clearRect(0, 0, chart.width, chart.height);
    const barW = chart.width / 7;
    for (let k = 0; k <= 6; k++) {
      const mu = 2 ** -k + t * (1 - 2 ** -k);
      const h = mu * (chart.height - 14);
      ctx.fillStyle = k === nSel ? "#C9A227" : "#555";
      ctx.fillRect(k * barW + 3, chart.height - 14 - h, barW - 6, h);
      ctx.fillStyle = "#aaa";
      ctx.font = "10px monospace";
      ctx.fillText(String(k), k * barW + barW / 2 - 3, chart.height - 2);
    }
  };

  alphaInput.oninput = () => { showAlpha(); drawChart(); };
  nInput.oninput = drawChart;
  drawChart();

  panel.append(header, alphaLabel, alphaInput, nLabel, nInput, apply, reset, chart, stats);
  document.body.appendChild(panel);

  return {
    toggle: () =>
      (panel.style.display = panel.style.display === "none" ? "block" : "none"),
    setStats: (text) => (stats.textContent = text),
  };
}