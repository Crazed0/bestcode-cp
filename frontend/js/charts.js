window.performanceChart = null;
const MAX_DATA_POINTS = 20;
const cpuDataHistory = Array(MAX_DATA_POINTS).fill(0);
const ramDataHistory = Array(MAX_DATA_POINTS).fill(0);
const chartLabels = Array(MAX_DATA_POINTS).fill('');

/**
 * Retorna as cores exatas do tema para as linhas e preenchimentos
 */
function getThemeColors() {
  const isGames = document.body.classList.contains('games-context');
  const isGeneral = document.body.classList.contains('general-context');
  if (isGames) {
    return {
      cpuLine: '#a124ff',        // Roxo neon
      cpuFill: 'rgba(161, 36, 255, 0.08)',
      ramLine: '#00e5ff',        // Ciano cyber (super distinto!)
      ramFill: 'rgba(0, 229, 255, 0.02)'
    };
  } else if (isGeneral) {
    return {
      cpuLine: '#1a6fd4',        // Premium brand blue
      cpuFill: 'rgba(26, 111, 212, 0.08)',
      ramLine: '#0a2952',        // BestCode Dark Blue
      ramFill: 'rgba(10, 41, 82, 0.02)'
    };
  } else {
    return {
      cpuLine: '#007acc',        // Azul BestCode
      cpuFill: 'rgba(0, 122, 204, 0.08)',
      ramLine: '#0a2952',        // Azul escuro BestCode
      ramFill: 'rgba(10, 41, 82, 0.02)'
    };
  }
}

function initPerformanceChart() {
  const ctx = document.getElementById('performanceChart');
  if (!ctx) return;

  const colors = getThemeColors();

  window.performanceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [
        {
          label: 'Uso de CPU (%)',
          data: cpuDataHistory,
          borderColor: colors.cpuLine,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: true,
          backgroundColor: colors.cpuFill,
          tension: 0.15
        },
        {
          label: 'Uso de RAM (%)',
          data: ramDataHistory,
          borderColor: colors.ramLine,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: false, // Sem fill para a RAM evita sobreposição de blocos de cor
          backgroundColor: 'transparent',
          tension: 0.15
        }
      ]
    },
    options: {
      animation: {
        duration: 800, // Transição linear de 800ms para um efeito de deslizamento super suave
        easing: 'linear'
      },
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: '#94a3b8',
            font: {
              family: 'JetBrains Mono',
              size: 11
            }
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false
        }
      },
      scales: {
        x: {
          display: false,
          grid: {
            display: false
          }
        },
        y: {
          min: 0,
          max: 100,
          grid: {
            color: 'rgba(255, 255, 255, 0.03)'
          },
          ticks: {
            color: '#64748b',
            font: {
              family: 'JetBrains Mono',
              size: 10
            },
            stepSize: 25
          }
        }
      },
      interaction: {
        intersect: false
      }
    }
  });
}

/**
 * Atualiza dinamicamente as cores do gráfico baseando-se no tema ativo
 */
window.updateChartColors = function() {
  if (!window.performanceChart) return;
  
  const colors = getThemeColors();

  window.performanceChart.data.datasets[0].borderColor = colors.cpuLine;
  window.performanceChart.data.datasets[0].backgroundColor = colors.cpuFill;
  window.performanceChart.data.datasets[1].borderColor = colors.ramLine;
  window.performanceChart.data.datasets[1].backgroundColor = colors.ramFill;
  
  window.performanceChart.update('none'); // Atualizações de cor de tema devem ser instantâneas
};

/**
 * Adiciona novas métricas ao gráfico e faz a atualização visual
 */
function updateChartData(cpuValue, ramValue) {
  if (!window.performanceChart) return;

  // Atualiza históricos
  cpuDataHistory.push(cpuValue);
  cpuDataHistory.shift();

  ramDataHistory.push(ramValue);
  ramDataHistory.shift();

  // Copia as referências dos arrays de dados para forçar o Chart.js a re-renderizar sem cache corrompido
  window.performanceChart.data.datasets[0].data = [...cpuDataHistory];
  window.performanceChart.data.datasets[1].data = [...ramDataHistory];

  // Renderiza a transição suave (flicker-free ao manter labels estáticos)
  window.performanceChart.update();
}

/**
 * Preenche o histórico completo do gráfico na inicialização
 */
window.updateChartHistory = function(history) {
  if (!window.performanceChart || !Array.isArray(history)) return;

  // Limpa históricos locais
  cpuDataHistory.length = 0;
  ramDataHistory.length = 0;

  // Adiciona os dados do backend
  history.forEach(item => {
    cpuDataHistory.push(item.cpu);
    ramDataHistory.push(item.ram);
  });

  // Ajusta o tamanho caso falte ou sobreponha o limite de pontos
  while (cpuDataHistory.length < MAX_DATA_POINTS) cpuDataHistory.push(0);
  while (ramDataHistory.length < MAX_DATA_POINTS) ramDataHistory.push(0);
  while (cpuDataHistory.length > MAX_DATA_POINTS) cpuDataHistory.shift();
  while (ramDataHistory.length > MAX_DATA_POINTS) ramDataHistory.shift();

  // Copia referências de dados
  window.performanceChart.data.datasets[0].data = [...cpuDataHistory];
  window.performanceChart.data.datasets[1].data = [...ramDataHistory];

  // Renderiza o gráfico instantaneamente sem animações na carga inicial
  window.performanceChart.update('none');
};

// Inicializa quando o DOM estiver pronto
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('performanceChart')) {
    initPerformanceChart();
  }
});
