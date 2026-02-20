export type Measurements = {
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;
  mercadoEnvios?: string;
};

// Fonte de dados (CSV-like) provida pelo usuário. Mantemos aqui em texto para
// facilitar futuras atualizações — o arquivo é parseado em tempo de import para
// gerar um lookup simples por categoria.
const RAW_CSV = `Categoria;Classe;Altura_cm;Largura_cm;Comprimento_cm;Peso_kg;Mercado_Envios
Acabamentos para Racks;M;20;25;125;4;OK
Acesso Lateral;G;30;45;155;12;Limitado
Acessórios de Caçamba;G;45;65;125;18;Limitado
Acessórios para Rodas;P;15;25;25;1;OK
Alargadores de Pára-Lamas;M;35;45;85;6;OK
Alerons e Asas;G;25;45;155;8;Limitado
Antenas de Conectividade;P;10;15;25;0.5;OK
Calotas;M;35;35;35;2;OK
Capas;G;35;45;55;5;OK
Capas para Pneus;P;15;35;35;1;OK
Carregadores Portáteis;P;15;15;20;0.5;OK
Carregadores de Parede;P;15;15;20;0.5;OK
Cintas de Reboque;P;20;25;35;2;OK
Câmeras de Ré;P;15;15;20;0.5;OK
Defletores;M;15;25;105;3;OK
Degraus;G;30;45;155;15;Limitado
Embelezadores;P;15;25;25;1;OK
Engates;G;35;45;85;25;Limitado
Espaçadores de Rodas;P;15;25;25;2;OK
Estribos;G;30;45;185;18;Limitado
Grades;M;35;45;85;5;OK
Molduras e Acabamentos;M;25;35;85;3;OK
Para-Barros Lameiras;M;25;35;55;2;OK
Parafusos Anti Furto;P;10;15;15;0.5;OK
Película para Vidros;P;15;15;65;1;OK
Placas;P;10;20;50;1;OK
Porta Pneus;G;45;65;85;20;Limitado
Protetores e Guardas;G;45;65;125;15;Limitado
Quebra Matos;G;55;85;125;30;Limitado
Racks e Bagageiros;G;35;45;125;15;Limitado
Reboques;XG;155;205;305;300;Frete próprio
Retira-neves;G;45;65;125;20;Limitado
Sensores de Estacionamento;P;15;20;25;1;OK
Snorkels;G;35;45;155;8;Limitado
Tow Straps;P;20;25;35;2;OK
Aquecedores;G;35;45;55;5;OK
Bandejas de Carga;G;25;55;105;8;Limitado
Cabos de Carregamento;P;10;15;25;1;OK
Cadeiras para Bebês;G;75;50;50;8;Limitado
Capas de Volante;P;15;35;35;1;OK
Capas para Bancos;M;35;45;55;4;OK
Capas para Cães;M;35;45;55;3;OK
Cobre Painéis;M;15;35;85;2;OK
Coifas Do Freio De Mão;P;10;15;20;0.5;OK
Componentes de Carregamento;P;10;15;20;1;OK
Cordas de Cobertura;P;20;25;35;2;OK
Câmera Veicular;P;15;15;20;0.5;OK
Instrumental;M;20;30;35;2;OK
Kits Monitoramento de Bateria;P;15;20;25;1;OK
Manoplas de Volantes;P;10;15;20;0.5;OK
Outros;M;25;35;45;3;OK
Porta-copos;P;15;15;20;0.5;OK
Protetores Cintos de Segurança;P;10;15;20;0.5;OK
Protetores Sanitários;P;10;20;25;1;OK
Quebra Sol;M;10;35;75;2;OK
Sacos de Lixo;P;15;20;25;1;OK
Tapetes;G;20;45;75;5;OK
Travas de Volantes;M;15;35;45;3;OK
Alarmes para Motos;P;10;15;20;0.5;OK
Alforges;M;35;45;55;4;OK
Alto-falantes;P;15;20;25;1;OK
Baús;G;45;45;55;6;OK
Capacetes;G;35;35;35;2;OK
Capas;G;35;45;55;3;OK
Cavaletes;G;45;45;75;8;Limitado
Elásticos de Bagagem;P;15;20;30;1;OK
Emblemas;P;10;15;20;0.5;OK
Falso Turbo;M;25;35;45;3;OK
Indumentária e Calçado;G;45;35;55;4;OK
Intercomunicadores;P;15;20;25;0.5;OK
Mochilas;M;35;35;45;2;OK
Painéis e Velocímetros;P;15;20;25;1;OK
Para-brisas;G;35;45;85;5;OK
Pedaleiras para Quadriciclos;M;20;30;35;3;OK
Peças para Capacetes;P;10;15;20;0.5;OK
Protetores de Guidão;P;15;20;30;1;OK
Protetores de Motor;G;35;45;55;6;OK
Protetores de Mãos;P;15;25;35;1;OK
Protetores de Radiador;M;25;35;45;3;OK
Rampas;G;20;35;105;12;Limitado
Redes Elásticas Aranha;P;15;20;30;1;OK
Sliders;P;15;20;25;1;OK
Straps;P;15;20;30;1;OK
Suportes de Para-brisas;P;15;20;30;1;OK
Travas e Elásticos;P;15;20;30;1;OK
Viseiras de Capacete;P;10;20;35;0.5;OK
Ajustáveis;M;10;15;35;1.5;OK
Combinada;M;10;15;35;1;OK
De Roda;G;15;25;45;3;OK
De Vela;P;10;15;25;0.5;OK
Fixa;M;10;15;35;1;OK
Outras;M;15;20;35;2;OK
Saca-Filtros de Óleo;M;15;20;30;1.5;OK
Tubos;G;15;25;55;4;OK
Cavaletes;G;45;35;45;8;OK
Elevadores Automotivos;XG;55;85;205;120;Frete próprio
Macacos;G;25;35;55;10;OK
Mesas Elevatórias Manuais;XG;45;75;125;80;Frete próprio
Outros;G;35;45;55;15;Limitado
Adaptadores de Scanners;P;10;15;20;0.5;OK
Conectores de Scanners;P;10;15;20;0.5;OK
Outros;M;15;25;35;2;OK
Scanners;M;15;25;35;1.5;OK
Espelhos de Inspeção;P;10;15;25;0.5;OK
Luzes de Inspeção;P;10;15;25;0.5;OK
Outros (Inspeção);M;15;25;35;2;OK
Cabos de Ponte;G;15;35;45;4;OK
Carregadores de Baterías;M;15;25;35;3;OK
Outros (Baterias);M;15;25;35;3;OK
Testadores de Baterías;P;10;20;25;1;OK
Guinchos Elétricos;XG;45;45;65;35;Frete próprio
Guinchos Manuais;G;25;35;55;15;Limitado
Outros (Guinchos);G;35;45;55;20;Limitado
Compressores de Ar;G;35;35;45;8;OK
Infladores de Chão;G;25;25;65;5;OK
Outros (Infladores);M;20;30;35;3;OK
Dinamômetros;M;20;30;35;3;OK
Medidores de Pressão;P;10;15;20;0.5;OK
Outros (Medição);M;15;25;35;2;OK
Torquímetros;M;10;15;45;2;OK
Catracas;M;10;15;35;1.5;OK
Outros (Soquetes);M;15;25;35;2;OK
Soquetes;P;10;15;25;1;OK
Aditivos (Carros e Caminhonetes);M;25;15;15;1.5;OK
Outros (Carros e Caminhonetes);M;25;20;20;2;OK
Óleos (Carros e Caminhonetes);G;30;20;20;5;OK
Aditivos (Motos);P;20;15;15;1;OK
Outros (Motos);P;20;15;15;1;OK
Óleos (Motos);M;25;15;15;1.5;OK
Baterias;G;35;25;55;18;Limitado
Carroceria;XG;75;150;300;120;Frete próprio
Climatização;M;30;30;50;12;Limitado
Condução Assistida Avançada;M;30;35;60;10;Limitado
Eletroventiladores;M;25;25;45;8;OK
Elétricos, Híbridos e PHEVM;M;30;30;50;15;Limitado
Escapamentos;G;20;40;120;15;Limitado
Fechaduras e Chaves;P;10;15;25;1;OK
Filtros;P;10;10;20;1;OK
Freios;G;25;35;55;10;Limitado
Ignição;P;10;15;20;1;OK
Iluminação;P;10;15;25;1;OK
Injeção;M;25;25;40;8;OK
Janelas e Vedações;G;20;50;100;12;Limitado
Motor;XG;70;60;100;150;Frete próprio
Outros;M;25;35;50;8;OK
Peças de Exterior;G;25;40;80;10;Limitado
Peças de Interior;M;25;35;50;8;OK
Segurança;M;25;30;50;6;OK
Sistema Elétrico;M;25;25;50;8;OK
Suspensão e Direção;G;30;40;70;15;Limitado
Transmissão;XG;50;60;120;100;Frete próprio
Câmaras de Ar;P;10;15;25;0.5;OK
Outros (Pneus e Acessórios);M;20;30;50;3;OK
Pneus Agrícolas;XG;100;40;100;120;Frete próprio
Pneus Industriais;XG;90;35;90;80;Frete próprio
Pneus de Carros e Caminhonetes;G;50;20;80;20;Limitado
Pneus para Aeronaves;XG;120;50;120;150;Frete próprio
Pneus para Bicicletas;P;15;5;70;2;OK
Pneus para Caminhões;XG;80;30;120;100;Frete próprio
Pneus para Carrinhos;P;10;10;25;1;OK
Pneus para Motos;G;25;15;65;8;Limitado
Pneus para Patinetes;P;10;15;25;0.5;OK
Pneus para Quadriciclos;G;35;20;85;12;Limitado
Selantes;P;10;15;25;1;OK
Rodas;G;25;25;45;10;Limitado
Adesivos de Remendo para Pneus;P;5;10;10;0.2;OK
Outras (Rodas);M;20;25;35;5;OK
Rodas de Carros e Caminhonetes;G;25;25;45;10;Limitado
Rodas para Caminhões;XG;50;50;120;60;Frete próprio
Rodas para Motos;G;20;20;40;5;Limitado
Rodas para Quadriciclos;G;20;20;45;8;Limitado
Baterias;G;35;25;55;25;Limitado
Caixas de Marchas;XG;60;50;120;120;Frete próprio
Climatização;G;30;30;60;20;Limitado
Eletroventiladores;M;25;25;45;10;OK
Escapamentos;G;20;40;120;25;Limitado
Fechaduras e Chaves;P;10;15;25;1;OK
Filtros;P;10;10;20;1;OK
Freios;G;25;35;55;15;Limitado
Ignição;P;10;15;20;1;OK
Iluminação;P;10;15;25;1;OK
Injeção;M;25;25;40;8;OK
Machados;G;30;20;85;12;Limitado
Motor;XG;70;60;100;200;Frete próprio
Outros;M;25;35;50;8;OK
Peças de Cabine;G;30;50;80;20;Limitado
Peças de Exterior;G;25;40;80;15;Limitado
Quadros;XG;60;100;200;80;Frete próprio
Segurança;M;25;30;50;8;OK
Sensores;P;10;15;20;0.5;OK
Sistema Elétrico;M;25;25;50;10;OK
Sistemas de Refrigeração;G;40;50;80;25;Limitado
Vidros;XG;60;40;100;50;Frete próprio
Alarmes e Acessórios;P;10;15;25;0.5;OK
Bafômetros;P;10;15;25;1;OK
Bate Rodas;P;10;15;25;1;OK
Coletes Refletivos;P;10;15;20;0.5;OK
Controles;P;10;15;20;0.5;OK
Correntes para Neve;M;20;25;50;5;OK
Extintores;M;25;20;50;5;OK
Insulfilms;P;15;15;65;1;OK
Kit de Segurança para Carros;M;20;25;50;3;OK
Porcas de Roda;P;10;10;10;0.5;OK
Rastreadores para Veículos;P;10;15;20;0.5;OK
Sirenes;P;10;15;25;1;OK
Travas Elétricas;P;10;15;20;0.5;OK
Travas para Volantes;M;15;35;45;3;OK
Triângulos de Segurança;P;10;15;25;0.5;OK
Alinhamento e Balanceamento;XG;50;50;100;50;Frete próprio
Cambio de Bateria;M;25;25;50;8;Limitado
Filtros e Fluidos;M;20;25;50;5;Limitado
Freios;G;25;35;55;15;Limitado
Motor;XG;50;60;120;120;Frete próprio
Outros (Serviços);M;20;25;50;5;Limitado
Transmissão;XG;50;60;120;100;Frete próprio
Tren Dianteiro;G;40;50;80;30;Limitado
Alto-Falantes;M;20;25;50;8;Limitado
Antenas;P;10;15;25;0.5;OK
Bazucas;G;25;25;60;10;Limitado
Cabos e Conectores;P;10;15;25;1;OK
Caixas Acústicas;G;25;25;60;10;Limitado
Capacitores;P;10;15;25;0.5;OK
Controles Remotos;P;10;15;20;0.5;OK
Cornetas;P;10;20;35;1;OK
DVD Player Automotivo;M;10;25;35;2;OK
Drivers;M;15;25;40;2;OK
Equalizadores;M;15;25;40;2;OK
Grades para Caixas de Som;M;15;25;40;2;OK
Interfaces;P;10;20;35;1;OK
Kits de Duas Vias;M;15;25;40;2;OK
Módulos Amplificadores;M;20;30;45;3;OK
Outros (Tuning);M;20;25;40;2;OK
Reprodutores;M;15;25;40;2;OK
Telas;M;20;30;40;3;OK
Tags de Pagamento de Pedágio;P;5;10;15;0.2;OK
Adesivos e Stickers;P;5;10;10;0.2;OK
Cromados;M;15;25;40;2;OK
Iluminação;P;10;15;25;0.5;OK
Insulfilms;P;15;15;65;1;OK
Merchandising;M;20;25;40;2;OK
Outros (Tuning);M;20;25;50;3;OK
Tintas;P;10;10;25;1;OK
Tuning Exterior;G;25;35;75;8;Limitado
Tuning Interior;M;25;35;50;5;Limitado`;

function normalize(s?: string) {
  return (s || "").toString().trim().toLowerCase();
}

// Parse CSV into lookup map keyed by normalized category name (short form)
const lines = RAW_CSV.split(/\r?\n/).filter(Boolean);
const header = lines.shift();

type CsvRow = {
  categoria: string;
  classe?: string;
  altura_cm?: number;
  largura_cm?: number;
  comprimento_cm?: number;
  peso_kg?: number;
  mercado_envios?: string;
};

const ML_MEASUREMENTS_MAP: Record<string, Measurements> = {};

for (const line of lines) {
  const parts = line.split(";").map((p) => p.trim());
  const [categoria, classe, altura, largura, comprimento, peso, mercado] =
    parts;
  const key = normalize(categoria);
  ML_MEASUREMENTS_MAP[key] = {
    heightCm: altura ? parseInt(altura, 10) : undefined,
    widthCm: largura ? parseInt(largura, 10) : undefined,
    lengthCm: comprimento ? parseInt(comprimento, 10) : undefined,
    weightKg: peso ? parseFloat(peso) : undefined,
    mercadoEnvios: mercado || undefined,
  };
}

/**
 * Retorna medidas para uma categoria. A função tenta (em ordem):
 * 1) combinar `detailedValue` (ex: "Carroceria e Lataria > Portas") com o nome curto da
 *    categoria armazenada no CSV (procura por substring);
 * 2) combinar `categoryValue` (top-level) com chaves do mapa (igualdade);
 * 3) tentar buscar por qualquer token da categoria no mapa (match parcial).
 */
export function getMeasurementsForCategory(
  categoryValue?: string,
  detailedValue?: string,
): Measurements | undefined {
  // 1) try detailedValue contains known short category
  if (detailedValue) {
    const dv = normalize(detailedValue);
    for (const k of Object.keys(ML_MEASUREMENTS_MAP)) {
      if (dv.includes(k)) return ML_MEASUREMENTS_MAP[k];
    }
  }

  // 2) try exact top-level match
  if (categoryValue) {
    const cv = normalize(categoryValue);
    if (ML_MEASUREMENTS_MAP[cv]) return ML_MEASUREMENTS_MAP[cv];

    // 3) partial token match against keys (also tolerate singular/plural and token overlap)
    const cvTokens = cv
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.replace(/s$/, ""));

    // Prefer direct token → key matches (singular/plural tolerant), e.g. 'roda' → 'rodas'
    for (const tok of cvTokens) {
      const pluralKey = `${tok}s`;
      if (ML_MEASUREMENTS_MAP[pluralKey]) return ML_MEASUREMENTS_MAP[pluralKey];
      if (ML_MEASUREMENTS_MAP[tok]) return ML_MEASUREMENTS_MAP[tok];
    }

    for (const k of Object.keys(ML_MEASUREMENTS_MAP)) {
      if (cv.includes(k) || k.includes(cv)) return ML_MEASUREMENTS_MAP[k];

      const keyTokens = k
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => t.replace(/s$/, ""));
      // match when any normalized token overlaps (e.g. 'roda' ⇄ 'rodas')
      if (
        cvTokens.some((tok) => keyTokens.includes(tok)) ||
        keyTokens.some((tok) => cvTokens.includes(tok))
      ) {
        return ML_MEASUREMENTS_MAP[k];
      }
    }
  }

  // 4) fallback: try to match any key that is a substring of either value
  const combined = normalize(`${categoryValue || ""} ${detailedValue || ""}`);
  for (const k of Object.keys(ML_MEASUREMENTS_MAP)) {
    if (combined.includes(k)) return ML_MEASUREMENTS_MAP[k];
  }

  return undefined;
}

export { ML_MEASUREMENTS_MAP };
