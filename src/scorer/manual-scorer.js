/**
 * manual-scorer.js
 * Rule-based mission-alignment scorer shared by run-scoring.js and expand-now.js.
 * Takes a raw grant object (not the {grant, prescore} wrapper) and returns
 * the same {mission_alignment, strategic_fit, best_projects, ...} shape that
 * Claude would return when scoring via the API.
 */

'use strict';

function scoreGrant(grant) {
  const text = (grant.title + ' ' + (grant.description || '')).toLowerCase();
  const src  = grant.source || '';
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
