/**
 * manual-scorer.js
 * Rule-based mission-alignment scorer shared by run-scoring.js and expand-now.js.
 * Takes a raw grant object (not the {grant, prescore} wrapper) and returns
 * the same {mission_alignment, strategic_fit, best_projects, ...} shape that
 * Claude would return when scoring via the API.
 */

'use strict';

// ── Re-usable INELIGIBLE response ─────────────────────────────────────────────
// combineScores() in scorer/index.js checks the `_ineligible` flag to set
// recommendation = 'INELIGIBLE' regardless of prescore flags.
function ineligible(reason) {
  return {
    mission_alignment: 0.0, strategic_fit: -0.2,
    best_projects: [], application_angle: null, confidence: 'high',
    reasoning: reason,
    _ineligible: true,   // ← signals combineScores() to force INELIGIBLE tier
  };
}

// Non-LAC country names that disqualify a grant if they appear in the title
const NON_LAC_IN_TITLE = /\b(africa|ghana|kenya|nigeria|ethiopia|tanzania|uganda|rwanda|mozambique|angola|zambia|zimbabwe|mali|senegal|cameroon|eswatini|swaziland|malawi|botswana|south africa|kigali|nairobi|accra|india|pakistan|bangladesh|vietnam|cambodia|myanmar|indonesia|philippines|china|thailand|nepal|pacific|ukraine|moldova|albania|georgia|armenia|balkans)\b/i;
const LAC_RESCUE       = /honduras|central america|latin america|caribbean|mesoamerica|lac\b/i;

function scoreGrant(grant) {
  const text = (grant.title + ' ' + (grant.description || '')).toLowerCase();
  const src  = grant.source || '';

  // ── Global pre-filter: catch things rules.js might miss ───────────────────

  // Wrong geography in title — even if rules.js didn't flag it (e.g. expanded digest items)
  if (NON_LAC_IN_TITLE.test(grant.title) && !LAC_RESCUE.test(grant.title)) {
    return ineligible(`Grant explicitly targets non-LAC geography: "${grant.title}". Not applicable to Sustenta Honduras.`);
  }

  // CFLI entries for non-Honduras countries — come through digest expansion
  if (/canada fund for local initiatives/i.test(grant.title) && !/honduras/i.test(grant.title)) {
    return ineligible('Canada Fund for Local Initiatives entry is for a non-Honduras country. Sustenta is not eligible.');
  }

  // Individual scholarship / beca — not org grant
  if (/\b(scholarship|beca[s]?\s+para\s+estudiar|estudia en|study abroad|becas\s+fundaci[oó]n)\b/i.test(text)) {
    return ineligible('Individual scholarship — not applicable to Sustenta as an organization.');
  }

  // Course / certification / payment for course
  if (/\b(pago\s+curso|certificaci[oó]n[:\s]|curso\s+de\s|buy.*course|inscripci[oó]n)\b/i.test(text) &&
      !/grant|fund|award/i.test(text)) {
    return ineligible('Course/certification fee — not a grant opportunity.');
  }

  // News analysis / opinion pieces (not a grant call)
  // Note: [''] matches both straight apostrophe and Unicode curly quote (U+2019)
  if (/^(how |why |what |the \w+ making |from |brazil['']s|china['']s|microfinance for|financing the|integrating peace|a key to unlock|growing interest)/i.test(grant.title) &&
      !/call for|apply|deadline|open for proposals/i.test(text)) {
    return ineligible('News analysis article — not an active grant call.');
  }
  // RSS feed articles that "appeared first on" a publisher site
  if (/appeared first on|this article originally appeared|read more at/i.test(grant.description || '') &&
      !/call for|apply|deadline|submission|open for|rfp|rfa|grant opportunity/i.test(text)) {
    return ineligible('News/blog article from RSS feed — not an active grant opportunity.');
  }

  // Conference/event call for submissions
  if (/\b(ocean gala|conference|summit|gala\s+nyc|call for.*designer|call for.*artist)\b/i.test(text) &&
      !/grant|fund|award/i.test(text)) {
    return ineligible('Conference/event — not a grant for NGOs.');
  }

  // VC / corporate innovation — not for NGOs
  if (/\b(venture fund|innovation hub|startup hub|vc fund|equity fund)\b/i.test(text) &&
      !/ngo|nonprofit|civil society/i.test(text)) {
    return ineligible('VC/startup hub — not accessible to NGOs like Sustenta.');
  }

  // Just a funder name listed with no open call (very short, no grant signal)
  if (grant.title && grant.title.length < 55 && (!grant.description || grant.description.length < 60) &&
      !/grant|fund|apply|call|proposal|deadline|award|opportunit/i.test(text)) {
    return ineligible('Funder name listed without a specific open call. Not actionable.');
  }

  // Known funder-name-only entries that come through ImpactFunding digest expansion
  const FUNDER_NAMES_ONLY = /^(aberdeen group charitable trust|toyota foundation|burroughs wellcome fund|ernest kleinwort|convergence blended finance|swedish energy agency|italian agency for development|opec fund|global affairs canada|all good ventures|western indian ocean|dutch caribbean nature|unicef venture fund|international organization for migration|one young world\b)/i;
  if (FUNDER_NAMES_ONLY.test(grant.title) && !/call for|apply|deadline|open|submission/i.test(text)) {
    return ineligible(`"${grant.title.slice(0,50)}" is a funder listing without an open call — not actionable.`);
  }

  const isGestionandote = src === 'RECID';
  const isGestion = src === 'Gestionandote' || src === 'Gestionándote';

  // ── RECID ──────────────────────────────────────────────────────────────────

  if (isGestionandote && grant.title.includes('Fondo Chile')) {
    return {
      mission_alignment: 0.7, strategic_fit: 0.0,
      best_projects: ['Aire Limpio Honduras', 'Honduras Carbono Cero / Climate Lab'],
      application_angle: 'Sustenta puede postular como ONG joven hondureña con track record bilateral en monitoreo ambiental y transferencia de capacidades sur-sur.',
      confidence: 'medium',
      reasoning: 'Fondo Chile financia cooperacion tecnica entre paises LAC. Alineacion parcial — no es explicitamente ambiental pero cubre innovacion social y transferencia de capacidades, donde Sustenta tiene ventaja competitiva.'
    };
  }

  if (isGestionandote && grant.title.includes('Innovacion Social en America Latina')) {
    return {
      mission_alignment: 0.9, strategic_fit: 0.05,
      best_projects: ['Economia Circular Ajuterique', 'Honduras Carbono Cero / Climate Lab'],
      application_angle: 'La economia circular en Ajuterique y el Climate Lab son casos de innovacion social con impacto medible en LAC.',
      confidence: 'medium',
      reasoning: 'Alta alineacion con innovacion social en LAC. Sustenta tiene proyectos concretos que encajan perfectamente en este perfil.'
    };
  }

  if (isGestionandote && grant.title.includes('133')) {
    return {
      mission_alignment: 0.85, strategic_fit: 0.05,
      best_projects: ['Guardianes del Bosque (La Mosquitia)', 'Red Hondurena de Municipios Verdes'],
      application_angle: 'Proyecto comunitario de alerta temprana con jovenes indigenas en La Mosquitia — combina tecnologia, comunidad y conservacion de bosques.',
      confidence: 'medium',
      reasoning: 'Financiamiento comunitario hasta $133k es el sweet spot de Sustenta. Guardianes del Bosque encaja perfectamente.'
    };
  }

  if (isGestionandote && grant.title.includes('FONTAGRO')) {
    return {
      mission_alignment: 0.3, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'high',
      reasoning: 'FONTAGRO financia innovacion agroalimentaria — fuera del foco de Sustenta.'
    };
  }

  if (isGestionandote && (grant.title.includes('Mujeres') || grant.title.includes('Genero'))) {
    return {
      mission_alignment: 0.2, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'high',
      reasoning: 'Convocatoria de genero y paz — fuera del enfoque tematico principal de Sustenta.'
    };
  }

  if (isGestionandote && (grant.title.includes('Curso') || grant.title.includes('Certificacion'))) {
    return {
      mission_alignment: 0.0, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'high',
      reasoning: 'Curso de capacitacion, no una convocatoria de grants.'
    };
  }

  // ── ImpactFunding: raw digest posts → SKIP; expanded individual grants → scored below ──

  if (src === 'ImpactFunding Substack' && /\d+\s+new\s+(impact\s+)?funding/i.test(grant.title)) {
    return {
      mission_alignment: 0.0, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'high',
      reasoning: 'Newsletter digest — individual grants extracted by digest-expander on next scan.'
    };
  }

  // ── IKI ────────────────────────────────────────────────────────────────────

  if (src === 'IKI Small Grants') {
    return {
      mission_alignment: 0.0, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'high',
      reasoning: 'IKI Small Grants call is currently closed. Monitor November–January for next annual call.'
    };
  }

  // ── Gestionándote specific grants ──────────────────────────────────────────

  if (isGestion && text.includes('ycjf')) {
    return {
      mission_alignment: 1.1, strategic_fit: 0.1,
      best_projects: ['Honduras Carbono Cero / Climate Lab', 'Aire Limpio Honduras', 'Economia Circular Ajuterique'],
      application_angle: 'Sustenta Honduras es exactamente el perfil YCJF: ONG joven liderada por jóvenes con proyectos de acción climática documentados.',
      confidence: 'high',
      reasoning: 'YCJF está diseñado exactamente para organizaciones como Sustenta: joven, liderada por jóvenes, acción climática en países en desarrollo. Máxima alineación.'
    };
  }

  if (isGestion && (text.includes('nama') || text.includes('mitigaci'))) {
    return {
      mission_alignment: 0.9, strategic_fit: 0.05,
      best_projects: ['Honduras Carbono Cero / Climate Lab', 'Aire Limpio Honduras'],
      application_angle: 'Honduras Carbono Cero puede posicionarse como NAMA subnacional con datos de emisión del Climate Lab.',
      confidence: 'medium',
      reasoning: 'NAMA Facility financia programas nacionales de mitigación climática. Alta alineación con Climate Lab y Aire Limpio.'
    };
  }

  if (isGestion && text.includes('zayed')) {
    return {
      mission_alignment: 0.8, strategic_fit: 0.0,
      best_projects: ['Economia Circular Ajuterique', 'Aire Limpio Honduras'],
      application_angle: 'Economía Circular Ajuterique puede competir en categoría Salud o Energía — impacto medible y réplica regional.',
      confidence: 'medium',
      reasoning: 'Premio Zayed hasta $100k. Economía Circular tiene el impacto demostrable que el premio valora.'
    };
  }

  if (isGestion && (text.includes('fondo chile') || (text.includes('chile') && text.includes('cooperaci')))) {
    return {
      mission_alignment: 0.7, strategic_fit: 0.0,
      best_projects: ['Aire Limpio Honduras', 'Honduras Carbono Cero / Climate Lab'],
      application_angle: 'Sustenta puede postular como ONG hondureña con track record en monitoreo ambiental y transferencia de capacidades sur-sur.',
      confidence: 'medium',
      reasoning: 'Fondo Chile financia cooperación técnica bilateral en LAC. Alineación parcial pero cubre innovación social y transferencia de capacidades.'
    };
  }

  if (isGestion && !text.includes('convocatoria') && !text.includes('fondo') && !text.includes('beca') && !text.includes('premio') && !text.includes('nominacion')) {
    return {
      mission_alignment: 0.0, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'high',
      reasoning: 'Homepage noise — not a specific grant call.'
    };
  }

  // ── UNDP GEF Small Grants Programme ───────────────────────────────────────

  if (src === 'UNDP SGP') {
    return {
      mission_alignment: 1.1, strategic_fit: 0.1,
      best_projects: ['Guardianes del Bosque (La Mosquitia)', 'Economia Circular Ajuterique', 'Aire Limpio Honduras'],
      application_angle: 'UNDP SGP Honduras directamente financia ONGs locales como Sustenta: $10k–$50k para biodiversidad, clima e indígenas — sin intermediario.',
      confidence: 'high',
      reasoning: 'Perfecto. UNDP SGP Honduras tiene programa activo, acepta aplicaciones directas de ONGs locales, y sus prioridades (biodiversidad, clima, comunidades indígenas, jóvenes) coinciden exactamente con los proyectos de Sustenta.'
    };
  }

  // ── CEPF ──────────────────────────────────────────────────────────────────

  if (src === 'CEPF') {
    return {
      mission_alignment: 1.0, strategic_fit: 0.05,
      best_projects: ['Guardianes del Bosque (La Mosquitia)', 'Economia Circular Ajuterique'],
      application_angle: 'Honduras está en el hotspot de biodiversidad Mesoamérica de CEPF — Guardianes del Bosque protegiendo La Mosquitia es exactamente el tipo de proyecto que financian.',
      confidence: 'high',
      reasoning: 'CEPF financia conservación de ecosistemas críticos en Mesoamérica. Honduras está dentro del hotspot. Guardianes del Bosque en La Mosquitia encaja perfectamente. Grants desde $5k hasta $500k para pequeñas ONGs.'
    };
  }

  // ── IAF ───────────────────────────────────────────────────────────────────

  if (src === 'IAF' || src === 'IAF / Grants.gov') {
    // Score individual IAF programs by content
    if (text.includes('environment') || text.includes('climate') || text.includes('natural resource')) {
      return {
        mission_alignment: 1.0, strategic_fit: 0.1,
        best_projects: ['Guardianes del Bosque (La Mosquitia)', 'Aire Limpio Honduras', 'Economia Circular Ajuterique'],
        application_angle: 'IAF ha invertido $57.9M en Honduras desde 1972 — Sustenta tiene el perfil exacto: ONG local, impacto comunitario medible, proyectos de base.',
        confidence: 'high',
        reasoning: 'IAF financia directamente ONGs en Honduras, acepta aplicaciones año redondo en inglés o español, sin deadline. Foco en organizaciones de base con impacto demostrable. Alta alineación.'
      };
    }
    if (text.includes('youth') || text.includes('joven') || text.includes('leader')) {
      return {
        mission_alignment: 1.1, strategic_fit: 0.1,
        best_projects: ['Honduras Carbono Cero / Climate Lab', 'Guardianes del Bosque (La Mosquitia)'],
        application_angle: 'Sustenta como ONG liderada por jóvenes con proyectos comunitarios medibles es el perfil ideal para IAF.',
        confidence: 'high',
        reasoning: 'IAF prioriza liderazgo juvenil y organizaciones grassroots. Sustenta encaja perfectamente.'
      };
    }
    return {
      mission_alignment: 0.9, strategic_fit: 0.1,
      best_projects: ['Honduras Carbono Cero / Climate Lab', 'Economia Circular Ajuterique'],
      application_angle: 'IAF financia directamente ONGs hondureñas — aplicar sin deadline es una ventaja enorme.',
      confidence: 'medium',
      reasoning: 'IAF es fondo US dedicado a LAC grassroots. Honduras es país prioritario. Año redondo, sin costo, en español. Explorar cuál programa se alinea mejor.'
    };
  }

  // ── Fast Forward ──────────────────────────────────────────────────────────

  if (src === 'Fast Forward') {
    return {
      mission_alignment: 1.0, strategic_fit: 0.1,
      best_projects: ['Aire Limpio Honduras', 'Honduras Carbono Cero / Climate Lab'],
      application_angle: 'Sustenta aplica como tech nonprofit: red nacional de sensores PM2.5 + plataforma de datos climáticos = exactamente el perfil de FFWD. Ventana: julio 30 – sept 8.',
      confidence: 'high',
      reasoning: 'Fast Forward financia tech nonprofits globales con $25k + red de mentores. Sustenta califica: ONG registrada, usa tecnología (sensores PM2.5, plataformas de datos) para resolver problemas ambientales. Deadline conocido: Sept 8, 2026.'
    };
  }

  // ── Climate Calling ───────────────────────────────────────────────────────

  if (src === 'Climate Calling') {
    if (text.includes('youth') || text.includes('young') || text.includes('joven') || text.includes('fellow')) {
      return {
        mission_alignment: 1.0, strategic_fit: 0.1,
        best_projects: ['Honduras Carbono Cero / Climate Lab', 'Guardianes del Bosque (La Mosquitia)'],
        application_angle: 'Sustenta como organización liderada por jóvenes en Honduras encaja perfectamente con las oportunidades de Climate Calling — liderazgo climático juvenil LAC.',
        confidence: 'medium',
        reasoning: 'Climate Calling cura oportunidades de liderazgo climático para jóvenes globalmente. Alta alineación con el perfil youth-led de Sustenta.'
      };
    }
    return {
      mission_alignment: 0.8, strategic_fit: 0.05,
      best_projects: ['Honduras Carbono Cero / Climate Lab'],
      application_angle: null, confidence: 'medium',
      reasoning: 'Oportunidad de liderazgo climático en Climate Calling. Revisar elegibilidad específica.'
    };
  }

  // ── Rainforest Trust ──────────────────────────────────────────────────────

  if (src === 'Rainforest Trust') {
    return {
      mission_alignment: 0.9, strategic_fit: 0.05,
      best_projects: ['Guardianes del Bosque (La Mosquitia)'],
      application_angle: 'Guardianes del Bosque en La Mosquitia — la selva tropical más grande de CA — es exactamente el tipo de proyecto de áreas protegidas que Rainforest Trust financia.',
      confidence: 'high',
      reasoning: 'Rainforest Trust financia creación de áreas protegidas y conservación comunitaria en LAC. Tres deadlines anuales (Mar/Jul/Oct). La Mosquitia es uno de los bosques más biodiversos de Centroamérica — alta relevancia.'
    };
  }

  // ── Climate Policy Initiative (RSS) ───────────────────────────────────────

  if (src === 'Climate Policy Initiative' || src === 'CPI') {
    if (text.includes('grant') || text.includes('fund') || text.includes('call') || text.includes('opportunit')) {
      return {
        mission_alignment: 0.7, strategic_fit: 0.0,
        best_projects: ['Honduras Carbono Cero / Climate Lab', 'Aire Limpio Honduras'],
        application_angle: null, confidence: 'medium',
        reasoning: 'CPI publica análisis de financiamiento climático. Algunos artículos mencionan convocatorias activas relevantes para LAC.'
      };
    }
    return {
      mission_alignment: 0.0, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'high',
      reasoning: 'Artículo de análisis de política climática — no es convocatoria activa.'
    };
  }

  // ── MAR Fund ──────────────────────────────────────────────────────────────

  if (src === 'MAR Fund') {
    return {
      mission_alignment: 1.1, strategic_fit: 0.1,
      best_projects: ['Guardianes del Bosque (La Mosquitia)', 'Economia Circular Ajuterique'],
      application_angle: 'MAR Fund es la convocatoria más directa para Honduras: $30k–$50k para conservación marina y costera, gestión de residuos, cambio climático y comunidades. Sustenta aplica con proyecto costero + economía circular.',
      confidence: 'high',
      reasoning: 'MAR Fund financia exclusivamente Honduras, Belice, Guatemala y México para el Arrecife Mesoamericano. Temas de residuos sólidos y cambio climático encajan con proyectos de Sustenta. Hasta $1,000 disponibles para ayudar a preparar propuesta.'
    };
  }

  // ── Youth Climate Justice Fund ────────────────────────────────────────────

  if (src === 'Youth Climate Justice Fund') {
    return {
      mission_alignment: 1.1, strategic_fit: 0.1,
      best_projects: ['Honduras Carbono Cero / Climate Lab', 'Aire Limpio Honduras'],
      application_angle: 'Sustenta como organización youth-led hondureña de justicia climática: monitoreo PM2.5 + economía circular + jóvenes = exactamente el perfil que busca YCJF. $20k–$40k, sin requisito de registro formal.',
      confidence: 'high',
      reasoning: 'YCJF financia organizaciones lideradas por jóvenes (<35) en justicia climática global. No requiere registro legal formal. Acepta solicitudes en español. Sustenta cumple todos los criterios: youth-led, LAC, trabajo climático con enfoque de justicia social.'
    };
  }

  // ── Youth4Climate ──────────────────────────────────────────────────────────

  if (src === 'Youth4Climate') {
    return {
      mission_alignment: 1.0, strategic_fit: 0.1,
      best_projects: ['Honduras Carbono Cero / Climate Lab', 'Guardianes del Bosque (La Mosquitia)'],
      application_angle: 'Sustenta aplica con líderes jóvenes (18–29) en soluciones climáticas en Honduras. Climate Lab y Guardianes del Bosque son casos concretos de soluciones climáticas comunitarias.',
      confidence: 'high',
      reasoning: 'Youth4Climate (PNUD + Italia) ofrece hasta $30k para organizaciones youth-led en 59 países. Honduras elegible. Sustenta encaja perfectamente: liderazgo juvenil, soluciones climáticas con dimensiones de justicia social.'
    };
  }

  // ── Canada CFLI ────────────────────────────────────────────────────────────

  if (src === 'Canada CFLI') {
    return {
      mission_alignment: 0.95, strategic_fit: 0.05,
      best_projects: ['Aire Limpio Honduras', 'Economia Circular Ajuterique', 'Honduras Carbono Cero / Climate Lab'],
      application_angle: 'Sustenta aplica como ONG local hondureña registrada con proyectos de acción climática medible: red PM2.5, economía circular, liderazgo climático juvenil. Acepta solicitudes en español.',
      confidence: 'high',
      reasoning: 'CFLI Honduras ofrece CAD $35k–$45k anualmente a ONGs locales registradas. Prioridades 2025 incluyen explícitamente acción climática y biodiversidad. Requiere análisis de género pero hay recursos de capacitación disponibles.'
    };
  }

  // ── Echoing Green ──────────────────────────────────────────────────────────

  if (src === 'Echoing Green') {
    return {
      mission_alignment: 1.0, strategic_fit: 0.05,
      best_projects: ['Aire Limpio Honduras', 'Honduras Carbono Cero / Climate Lab'],
      application_angle: 'Fundador(a) de Sustenta aplica como emprendedor/a social emergente en justicia climática: red PM2.5 + plataforma de datos en Honduras. $90k durante 18 meses para trabajo a tiempo completo.',
      confidence: 'medium',
      reasoning: 'Echoing Green apoya emprendedores sociales jóvenes en etapa temprana. El fellowship va al individuo fundador, no a la organización — pero puede canalizarse a proyectos. Alta competencia (2,000+ solicitudes, ~50 fellows). Elegibilidad global, foco en justicia climática.'
    };
  }

  // ── MIT Solve ──────────────────────────────────────────────────────────────

  if (src === 'MIT Solve') {
    const hasClimate = /climat|environment|sustain|energy|water|forest|biodiv/i.test(text);
    return {
      mission_alignment: hasClimate ? 1.0 : 0.7, strategic_fit: 0.05,
      best_projects: ['Aire Limpio Honduras', 'Honduras Carbono Cero / Climate Lab'],
      application_angle: 'Sustenta aplica como equipo de innovación climática: red de sensores PM2.5 de bajo costo + plataforma de datos comunitaria en Honduras. MIT brinda $10k base + premios temáticos de $50k–$200k.',
      confidence: 'medium',
      reasoning: 'MIT Solve acepta organizaciones LAC y tiene historial de ganadores latinoamericanos. Requiere perfil de innovación tecnológica — Sustenta califica con su red de monitoreo PM2.5 como solución escalable.'
    };
  }

  // ── Mercociudades ──────────────────────────────────────────────────────────

  if (src === 'Mercociudades') {
    if (text.includes('environment') || text.includes('climat') || text.includes('agua') || text.includes('residuo') ||
        text.includes('joven') || text.includes('youth') || text.includes('sostenib')) {
      return {
        mission_alignment: 0.8, strategic_fit: 0.0,
        best_projects: ['Red Hondurena de Municipios Verdes', 'Economia Circular Ajuterique'],
        application_angle: null, confidence: 'medium',
        reasoning: 'Mercociudades agrega oportunidades de UNESCO, PNUD, BID para LAC. Revisar elegibilidad directa — algunas requieren intermediación municipal.'
      };
    }
    return {
      mission_alignment: 0.4, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'medium',
      reasoning: 'Oportunidad de Mercociudades sin alineación clara con temas de Sustenta.'
    };
  }

  // ── HeroX ──────────────────────────────────────────────────────────────────

  if (src === 'HeroX') {
    const isEnv = /environ|climat|sustain|water|energy|air|waste|biodiv|forest|ocean|carbon|recycl/i.test(text);
    if (isEnv) {
      return {
        mission_alignment: 0.75, strategic_fit: 0.0,
        best_projects: ['Aire Limpio Honduras', 'Honduras Carbono Cero / Climate Lab'],
        application_angle: null, confidence: 'medium',
        reasoning: 'Desafío de innovación ambiental en HeroX. Evaluar si el alcance técnico encaja con capacidad de Sustenta y si Honduras/LAC es elegible.'
      };
    }
    return {
      mission_alignment: 0.3, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'medium',
      reasoning: 'Desafío de innovación HeroX sin alineación temática con Sustenta.'
    };
  }

  // ── IDB/BID ────────────────────────────────────────────────────────────────

  if (src === 'IDB/BID') {
    if (text.includes('environment') || text.includes('climate') || text.includes('water') ||
        text.includes('waste') || text.includes('youth') || text.includes('innovation')) {
      return {
        mission_alignment: 0.8, strategic_fit: 0.0,
        best_projects: ['Economia Circular Ajuterique', 'Aire Limpio Honduras', 'Red Hondurena de Municipios Verdes'],
        application_angle: null, confidence: 'medium',
        reasoning: 'Convocatoria BID con alineación ambiental/climática para LAC. Verificar si es accesible para ONG local o requiere intermediación de gobierno/INGO.'
      };
    }
    return {
      mission_alignment: 0.5, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'medium',
      reasoning: 'Convocatoria BID — revisar si aplica directamente para ONGs hondureñas.'
    };
  }

  // ── Terra Viva Grants (RSS) ────────────────────────────────────────────────

  if (src === 'Terra Viva Grants') {
    // Terra Viva covers agriculture, biodiversity, climate, energy, water in developing countries
    const isHighAlign = /biodiv|forest|climat|air|water|sustain|conservation|Honduras|Central America|LAC/i.test(text);
    const isGrant = /grant|fund|award|fellowship|prize|convocatoria|oportunid/i.test(text);

    if (!isGrant) {
      return {
        mission_alignment: 0.0, strategic_fit: 0.0,
        best_projects: [], application_angle: null, confidence: 'high',
        reasoning: 'Noticia de Terra Viva — no es convocatoria activa.'
      };
    }
    if (isHighAlign) {
      return {
        mission_alignment: 0.85, strategic_fit: 0.0,
        best_projects: ['Guardianes del Bosque (La Mosquitia)', 'Economia Circular Ajuterique'],
        application_angle: null, confidence: 'medium',
        reasoning: 'Terra Viva lista convocatorias de biodiversidad/clima/agua para países en desarrollo. Alta relevancia para Honduras. Verificar elegibilidad específica.'
      };
    }
    return {
      mission_alignment: 0.6, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'medium',
      reasoning: 'Convocatoria de Terra Viva — posiblemente relevante para proyectos de Sustenta. Revisar detalles.'
    };
  }

  // ── Devex (RSS) ────────────────────────────────────────────────────────────

  if (src === 'Devex News') {
    const isGrant = /grant|fund|rfp|rfa|call for proposal|award|fellowship/i.test(text);
    const isEnv = /environ|climat|sustain|water|biodiv|energy|forest|air quality/i.test(text);
    const isLAC = /honduras|central america|latin america|LAC|caribbean|mesoamerica/i.test(text);

    if (isGrant && isEnv && isLAC) {
      return {
        mission_alignment: 0.8, strategic_fit: 0.0,
        best_projects: ['Aire Limpio Honduras', 'Honduras Carbono Cero / Climate Lab'],
        application_angle: null, confidence: 'medium',
        reasoning: 'Devex reporta convocatoria ambiental/climática para LAC. Revisar elegibilidad para ONG hondureña.'
      };
    }
    if (isGrant && isEnv) {
      return {
        mission_alignment: 0.6, strategic_fit: 0.0,
        best_projects: [], application_angle: null, confidence: 'medium',
        reasoning: 'Devex reporta convocatoria ambiental — puede no ser específica para LAC. Revisar.'
      };
    }
    return {
      mission_alignment: 0.0, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'high',
      reasoning: 'Artículo de noticias Devex — no es convocatoria activa o no aplica para Sustenta.'
    };
  }

  // ── Grant & Co Partners (RSS) ─────────────────────────────────────────────

  if (src === 'Grant & Co Partners') {
    const isGrant = /grant|fund|award|fellowship|prize/i.test(text);
    const isEnv = /environ|climat|sustain|water|biodiv|energy|forest|circular|waste/i.test(text);
    const isYouth = /youth|young|joven/i.test(text);

    if (isGrant && (isEnv || isYouth)) {
      return {
        mission_alignment: 0.75, strategic_fit: 0.0,
        best_projects: ['Honduras Carbono Cero / Climate Lab', 'Economia Circular Ajuterique'],
        application_angle: null, confidence: 'medium',
        reasoning: 'Grant & Co Partners cura convocatorias semanales incluyendo ambiente/juventud. Revisar elegibilidad específica para Honduras.'
      };
    }
    if (!isGrant) {
      return {
        mission_alignment: 0.0, strategic_fit: 0.0,
        best_projects: [], application_angle: null, confidence: 'high',
        reasoning: 'Contenido de Grant & Co Partners — no identificado como convocatoria activa.'
      };
    }
    return {
      mission_alignment: 0.5, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'medium',
      reasoning: 'Convocatoria de Grant & Co Partners — revisar si aplica para Honduras.'
    };
  }

  // ── Bond UK ────────────────────────────────────────────────────────────────

  if (src === 'Bond UK') {
    return {
      mission_alignment: 0.0, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'high',
      reasoning: 'Conference announcement, not a grant call.'
    };
  }

  // ── ReliefWeb / generic ────────────────────────────────────────────────────

  if (grant.url && grant.url.includes('/report/honduras/') && (text.includes('fund') || text.includes('grant'))) {
    return {
      mission_alignment: 0.3, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'high',
      reasoning: 'Noticia sobre financiamiento en Honduras — útil como inteligencia sobre donantes activos, no es convocatoria directa.'
    };
  }

  if (text.includes('early warning') && (text.includes('latin america') || text.includes('caribb') || text.includes('climate'))) {
    return {
      mission_alignment: 0.8, strategic_fit: 0.05,
      best_projects: ['Guardianes del Bosque (La Mosquitia)', 'Aire Limpio Honduras'],
      application_angle: 'Sustenta implementa sistemas de alerta temprana comunitaria en La Mosquitia — caso de uso directo para financiamiento MHEWS.',
      confidence: 'medium',
      reasoning: 'Alta alineación con Guardianes del Bosque. Trabajo con comunidades indígenas es referencia directa para estos fondos.'
    };
  }

  if ((text.includes('air quality') || text.includes('pm2')) && text.includes('fund')) {
    return {
      mission_alignment: 1.1, strategic_fit: 0.1,
      best_projects: ['Aire Limpio Honduras'],
      application_angle: 'Red nacional de PM2.5 en 18 departamentos es la referencia técnica más sólida de Sustenta para grants de calidad del aire.',
      confidence: 'medium',
      reasoning: 'Alineación perfecta con proyecto core. Red de monitoreo PM2.5 es el activo más diferenciado para estos fondos.'
    };
  }

  if (text.includes('ifad') || text.includes('smallholder')) {
    return {
      mission_alignment: 0.2, strategic_fit: 0.0,
      best_projects: [], application_angle: null, confidence: 'high',
      reasoning: 'IFAD financia proyectos agrícolas con pequeños productores — fuera del foco de Sustenta.'
    };
  }

  // ── Expanded ImpactFunding individual grants: score by content ─────────────

  if (grant._from_digest) {
    return scoreExpandedGrant(grant, text);
  }

  // Generic fallback
  return {
    mission_alignment: 0.1, strategic_fit: -0.1,
    best_projects: [], application_angle: null, confidence: 'high',
    reasoning: 'Artículo de noticias/reporte — no es convocatoria activa.'
  };
}

/** Score an individual grant extracted from a digest. */
function scoreExpandedGrant(grant, text) {
  const projects = [];
  let mission = 0.3;
  let fit = 0.0;
  let angle = null;
  let reasoning = 'Individual grant extracted from ImpactFunding newsletter.';

  if (/air quality|pm2\.?5|pollution|contaminaci/i.test(text)) {
    projects.push('Aire Limpio Honduras');
    mission = Math.max(mission, 1.0);
    fit = 0.1;
    angle = 'Air quality / PM2.5 monitoring directly aligns with Sustenta\'s national sensor network.';
  }
  if (/circular economy|economia circular|waste|recycl|residuo/i.test(text)) {
    projects.push('Economia Circular Ajuterique');
    mission = Math.max(mission, 0.85);
    angle = angle || 'Circular economy / waste valorization aligns with Ajuterique project.';
  }
  if (/indigenous|forest|bosque|mosquitia|early warning|alerta temprana/i.test(text)) {
    projects.push('Guardianes del Bosque (La Mosquitia)');
    mission = Math.max(mission, 0.8);
    angle = angle || 'Forest protection / early warning aligns with Guardianes del Bosque.';
  }
  if (/youth|joven|young people|liderado por j/i.test(text)) {
    projects.push('Honduras Carbono Cero / Climate Lab');
    mission = Math.max(mission, 0.9);
    fit = Math.max(fit, 0.05);
    angle = angle || 'Youth-focused fund matches Sustenta\'s youth-led profile.';
  }
  if (/climate|clima|carbono|carbon|greenhouse|decarboni/i.test(text)) {
    if (!projects.includes('Honduras Carbono Cero / Climate Lab')) projects.push('Honduras Carbono Cero / Climate Lab');
    mission = Math.max(mission, 0.75);
    angle = angle || 'Climate / carbon focus aligns with Climate Lab and decarbonization strategy.';
  }
  if (/water|agua|watershed|cuenca/i.test(text)) {
    projects.push('Red Hondurena de Municipios Verdes');
    mission = Math.max(mission, 0.7);
  }

  if (projects.length === 0) {
    mission = 0.2;
    reasoning = 'Extracted from digest but no strong thematic alignment found with Sustenta\'s projects.';
  } else {
    reasoning = `Extracted from ImpactFunding digest. Thematic match with: ${projects.join(', ')}.`;
  }

  return {
    mission_alignment: mission,
    strategic_fit: fit,
    best_projects: [...new Set(projects)],
    application_angle: angle,
    confidence: 'medium',
    reasoning,
  };
}

module.exports = { scoreGrant };
