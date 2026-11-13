# AgentDoc — plan d’implémentation pour un outil destiné aux agents IA

## 1. Résultat visé

Transformer AgentDoc en moteur de contexte opérationnel : un agent décrit une tâche, reçoit les connaissances nécessaires pour agir, approfondit les points utiles et actualise son contexte après les modifications.

L’objectif principal est de réduire le **coût total d’une tâche correctement terminée**, sous contrainte de fiabilité. Le coût inclut les appels au modèle, les outils, les vérifications, les reprises et les échecs. La longueur d’une réponse et la vitesse d’une requête sont des mesures intermédiaires.

Public cible : agents de développement et systèmes qui pilotent leurs sessions. Le protocole, les erreurs et les sorties sont conçus pour leur utilisation directe. Les documents humains servent à maintenir le projet ; ils ne constituent pas l’interface de travail obligatoire de l’agent.

Ce document décrit la cible et ses critères. La version 1.5.0 implémente le protocole, le cache conservateur, les API de session, les expériences de symboles et le runner d’évaluation. Le suivi ci-dessous distingue les fonctionnalités disponibles des résultats empiriques restant à établir.

## 2. Point de départ et invariants

État constaté lors de l’audit de la version locale 1.4.0 :

- Les 30 scénarios déterministes retrouvent les 101 faits attendus. Ils n’évaluent pas la résolution d’une tâche par un modèle.
- Les 422 tests passent avec la signature Git désactivée pour l’exécution. Les dépôts temporaires héritent sinon de la configuration de signature de la machine.
- Le rendu Markdown par défaut ne transmet pas toutes les garanties de l’objet interne. Reproductions : une vérification affichée sur quatre sans avertissement sur la fixture Rust ; un conflit affiché sur quatre sans avertissement sur Koda, avec des budgets explicites de un.
- `query` et `impact` recompilent chacun le dépôt. Des lectures, parsings et constructions d’index sont répétés.
- Les budgets portent sur des nombres d’éléments ; certaines surfaces, dont les engagements de revue globaux, restent non bornées.

Préserver pendant toute la migration :

1. La distinction entre faits déclarés, dérivés et observés, avec leur provenance.
2. Les conflits et les inconnues explicites. Une absence de résultat n’est pas une preuve d’absence.
3. La reproductibilité du graphe et la validation stricte des schémas.
4. La détection des entrées modifiées, ajoutées, supprimées ou nouvellement résolues.
5. Les règles de secret, de chemin, de propriété et de validité des observations.
6. La distinction entre une vérification recommandée, exécutée, réussie et encore valide.

La compilation complète reste la référence de correction. Aucun résultat de performance ne justifie une perte silencieuse d’information critique.

## 3. Décisions d’architecture

### Interface principale

Ajouter trois opérations, d’abord exposées en CLI avec JSON sur stdin/stdout et diagnostics sur stderr :

| Opération | Entrée | Résultat |
|---|---|---|
| `prepare` | tâche, chemins ou diff, intention, budget | paquet de travail sur un instantané explicite |
| `expand` | référence de paquet, éléments ou continuation | connaissances supplémentaires du même instantané |
| `refresh` | paquet précédent et état courant du dépôt | changements de connaissances et obligations invalidées |

Le CLI appelle une interface JavaScript commune. Un transport MCP pourra l’exposer ensuite sans reproduire sa logique. Aucun serveur permanent n’est requis pour la première livraison.

`prepare` rassemble résolution, impact, contraintes, preuves et sélection des vérifications sur un seul instantané. Les intentions initiales sont `implement`, `change-contract`, `debug-runtime` et `review`. Elles modifient les priorités de présentation ; elles ne permettent pas, à elles seules, d’exclure une obligation.

### Paquet de travail

Créer un schéma de paquet indépendant du schéma du graphe, versionné `agentdoc.dev/context/v1` et fermé aux champs inconnus. Il comprend :

- `snapshot` : empreinte des entrées, versions des extracteurs et schémas ; le commit seul ne suffit pas pour un arbre modifié ;
- `task` et `scope` : demande normalisée, sujets résolus, portée effective ;
- `coverage` : capacités d’analyse disponibles, chemins non couverts, résultats partiels et ambiguïtés ;
- `requirements`, `conflicts`, `facts` : connaissances utiles et leur statut d’autorité ;
- `evidence` : références adressables, empreintes et localisateurs ;
- `checks` : vérifications sélectionnées, justification, portée et contexte d’exécution ;
- `budget`, `omitted`, `continuation` : consommation, omissions explicites et moyen de poursuivre.

Séparer l’incomplétude due au budget, une analyse non prise en charge et un conflit non résolu. Un paquet complet signifie complet dans la portée et les capacités annoncées, jamais connaissance exhaustive du dépôt.

### Frontières internes

| Module cible | Responsabilité | Base existante |
|---|---|---|
| `core/context/` | préparation, sélection, sérialisation et approfondissement | `query.mjs`, `impact.mjs`, `dependents.mjs` |
| `core/snapshot.mjs` | accès cohérent aux entrées et identité de l’instantané | `fsx.mjs`, `compile.mjs` |
| `core/cache/` | résultats intermédiaires et invalidation | suivi des lectures, probes et listings |
| `core/session/` | références livrées, versions et deltas | nouveau |
| `evals/agent/` | exécution des tâches et comparaison des variantes | nouveau, distinct du routage déterministe |

Introduire ces modules avec leurs premiers usages. Éviter une extraction massive préalable de fonctions ou une seconde implémentation des règles d’autorité.

## 4. Lots d’implémentation

### Lot 0 — rendre la mesure reproductible

**Dépendance :** aucune.

**Travaux**

- Désactiver la signature des commits dans les dépôts de test et les utilitaires qui les créent, sans changer la configuration Git de l’utilisateur. Conserver des cas explicites pour les règles Git que le produit doit réellement respecter.
- Recenser les autres créations de dépôts qui contournent `tests/helpers.mjs` et appliquer la même isolation.
- Ajouter une instrumentation opt-in : durée par étape, octets lus, lectures physiques, parsings, reconstructions d’index, taille sérialisée et mémoire du processus.
- Émettre cette télémétrie hors du graphe et hors du contexte envoyé au modèle. Les horodatages et mesures de machine ne doivent pas casser le déterminisme.
- Enregistrer une référence sur les fixtures et les dépôts publics déjà épinglés, avec matériel, versions, nombre de répétitions et état froid/chaud.

**Fichiers :** `tests/helpers.mjs`, créateurs de fixtures, `core/fsx.mjs`, `core/compile.mjs`, `scripts/bench/run.mjs`, `docs/BENCHMARK.md`.

**Acceptation :** suite indépendante de la signature locale ; instrumentation sans effet sur les sorties fonctionnelles ; comparaison répétée de `query`, `impact` et séquences de requêtes. Les temps historiques de la version 1.2.0 restent identifiés comme tels.

### Lot 1 — rendre les sorties fidèles au moteur

**Dépendance :** lot 0.

**Travaux**

- Définir les informations que chaque format doit restituer : contraintes, conflits pertinents, statut d’autorité, obligations de vérification et indications d’incomplétude.
- Corriger le Markdown : afficher les troncatures de toutes les sections plafonnées, les gates applicables, les faits utiles des observations et les relations nécessaires pour comprendre l’impact.
- Préserver la distinction entre conflit résolu et non résolu ; ne pas présenter toutes les décisions comme des contradictions encore ouvertes.
- Tester les sorties réellement sérialisées et les invocations CLI. L’évaluation de l’objet interne reste utile mais ne suffit plus.
- Ajouter des scénarios où une information critique se situe au-delà des plafonds par défaut.

**Fichiers :** `core/query.mjs`, `core/impact.mjs`, `bin/agentdoc.mjs`, `evals/harness.mjs`, `tests/modes.test.mjs`, `tests/evals.test.mjs`, `docs/QUERY.md`.

**Acceptation :** les reproductions Rust et Koda ne perdent plus silencieusement d’obligations ; les gates ne disparaissent pas au rendu ; toutes les omissions sont détectables par l’agent. La brièveté n’est pas un critère de refus de ce correctif.

**Livraison :** correctif autonome, compatible avec les commandes actuelles.

### Lot 2 — installer l’évaluation avec de vrais agents

**Dépendance :** lot 0 ; mesurer la version avant et après le lot 1.

**Travaux**

- Créer un runner reproductible avec adaptateurs de modèles, limites d’appels, de temps et de coût, environnement isolé et collecte des sorties d’outils.
- Constituer un premier corpus de 30 tâches exécutables : correctifs, modifications de contrat, migrations, conflits de documentation, diagnostic à partir d’observations enregistrées et changements transverses.
- Utiliser des commits épinglés, des validateurs indépendants du graphe et des tests non exposés à l’agent. Une tâche doit pouvoir être évaluée sans compter les libellés choisis par AgentDoc.
- Séparer tâches de développement et tâches réservées à la validation, en séparant aussi les dépôts ou familles de tâches lorsque nécessaire pour limiter les fuites.
- Comparer recherche/lecture seules, AgentDoc de référence et variante candidate. Garder les mêmes outils de modification et de test, le même modèle et les mêmes budgets ; compter les instructions supplémentaires d’AgentDoc dans le coût.
- Commencer par un modèle pour stabiliser le runner, puis confirmer les décisions majeures sur au moins deux modèles épinglés. Exécuter au moins trois répétitions par tâche et configuration lors du pilote ; augmenter l’échantillon si la décision reste incertaine.
- Conserver les 30 scénarios déterministes actuels comme tests de régression séparés, avec leurs seuils inchangés.

**Fichiers :** nouveaux `evals/agent/`, `evals/agent/tasks/`, configuration des campagnes, `docs/EVALS.md`, script npm dédié.

**Acceptation :** les trois variantes peuvent résoudre la même tâche depuis le même état initial ; un patch erroné échoue même si son contexte semble correct ; les erreurs d’infrastructure sont distinguées des échecs de l’agent et restent comptabilisées dans les rapports d’exécution.

**Livraison :** runner et référence figée. Les campagnes payantes sont explicites, avec plafond configuré ; elles ne s’ajoutent pas automatiquement à chaque CI.

### Lot 3 — livrer `prepare` et `expand`

**Dépendance :** lots 1 et 2.

**Travaux**

- Créer le schéma du paquet et le validateur des requêtes, puis brancher les deux commandes dans la table commune des commandes et de l’aide.
- Réutiliser un même graphe et un même index pour tous les chemins de la requête. Dédupliquer les obligations par identité et version.
- Calculer un périmètre pertinent pour les engagements de revue ; conserver les engagements globaux explicitement applicables, pas tous ceux des composants sans rapport.
- Fournir des extraits ciblés de contraintes et contrats, avec chemin, localisateur et empreinte. Une référence vers un document ne remplace pas automatiquement son contenu nécessaire à la décision.
- Donner aux vérifications un contexte d’exécution explicite. Préserver les commandes shell comme telles ; ne pas convertir naïvement une chaîne shell en liste d’arguments. Marquer une commande non exécutable automatiquement si son contexte ne peut pas être établi.
- Implémenter un classement déterministe : obligations applicables d’abord, preuves utiles ensuite, détails complémentaires enfin. L’ordre reste stable à entrée identique.
- Ajouter un adaptateur de comptage de tokens avec tokenizer et version épinglés. Le mode à budget strict refuse un tokenizer indisponible ; une estimation éventuelle est explicitement distincte.
- Compter le paquet final, y compris les métadonnées, erreurs et continuations. Recompter après sérialisation. Si même l’enveloppe minimale ne tient pas, refuser le budget demandé.
- Si les obligations dépassent le budget, retourner un état partiel et une continuation. Ne jamais présenter une sélection de checks comme la liste complète.
- Lier les continuations à l’instantané, à la requête et à la version du protocole. Un instantané disparu ou périmé appelle un nouveau `prepare` ; aucune continuation ne mélange deux versions du dépôt.

**Fichiers :** nouveaux `schemas/context.schema.json`, `core/context/`, modifications de `bin/commands.mjs`, `bin/agentdoc.mjs`, `core/query.mjs`, `core/impact.mjs`, `core/indexes.mjs`.

**Acceptation :** une invocation prépare un paquet multi-chemins ; tous les faits sont justifiables ; budgets stricts respectés sur la sortie réelle ; approfondissements sans perte ni duplication incohérente ; aucun programme du dépôt n’est exécuté par la préparation.

**Livraison :** commandes additives expérimentales ; `query` et `impact` restent utilisables avec leurs contrats existants.

### Lot 4 — accélérer les lectures et partager les index

**Dépendance :** lot 3.

**Travaux**

- Introduire un instantané de lecture par requête avec cache des octets et des parsings. Inclure les options et versions du parseur dans les clés de réutilisation.
- Réutiliser les index d’entités, chemins, contrats, relations, assertions et dépendants au sein de cet instantané.
- Détecter une modification concurrente pendant la capture : vérifier la cohérence des entrées et listings, réessayer de façon bornée, puis signaler un dépôt instable. Ne pas publier un graphe composé de versions incompatibles.
- Éviter de relire un graphe disque si l’opération travaille explicitement sur l’instantané courant. Préserver la politique de fraîcheur existante de `query` pendant la migration.
- Borner la mémoire ; éviction et cache désactivé restent des modes corrects.

**Fichiers :** `core/snapshot.mjs`, `core/fsx.mjs`, `core/compile.mjs`, `core/context/`, `core/dependents.mjs`.

**Acceptation :** mêmes résultats avec et sans cache ; tests de mutation pendant une capture ; réduction mesurée des lectures physiques et reconstructions d’index ; absence de régression matérielle de mémoire sur les corpus choisis.

### Lot 5 — compilation incrémentale persistante

**Dépendance :** lot 4.

**Travaux**

- Enregistrer les dépendances entre entrées, résultats d’extraction et faits produits. Commencer par les parsings et extracteurs dont les dépendances sont précisément connues ; recalculer les autres intégralement.
- Identifier les résultats par le contenu des entrées, les options et les versions du compilateur, des schémas et adaptateurs.
- Conserver les dépendances négatives : existence testée mais absente, listes de répertoires, règles d’exclusion et chemins candidats de résolution.
- Invalider sur modification, ajout, suppression, renommage, changement de résolution, de configuration, d’exclusion ou d’extracteur. Reprendre les règles existantes pour les chemins et liens symboliques.
- Garder l’évaluation temporelle des observations hors d’un cache supposé immuable : une observation peut expirer sans changement de fichier.
- Stocker le cache sous `.agentdoc/`, séparé du graphe publié. Écritures atomiques, concurrence contrôlée et récupération par recalcul après corruption ou interruption.
- Exécuter un mode comparatif qui calcule aussi la compilation complète. Activer progressivement le chemin incrémental après comparaison des résultats.
- Garder une compilation complète en CI comme référence indépendante du cache.

**Fichiers :** `core/cache/`, `core/compile.mjs`, `core/fsx.mjs`, adaptateurs progressivement instrumentés, tests de mutations et de déterminisme.

**Acceptation :** identité des graphes, diagnostics et provenances entre les deux chemins sur les mutations du corpus ; cache absent, corrompu ou périmé sans faux résultat frais ; bénéfice mesuré sur les petites modifications et requêtes répétées.

**Livraison :** activation optionnelle, puis par défaut après validation. Revenir au calcul complet ne change pas le protocole.

### Lot 6 — mémoire de session et `refresh`

**Dépendance :** lots 3 et 4 ; le lot 5 accélère ce lot sans être nécessaire à sa correction.

**Travaux**

- Donner aux faits une identité logique stable et une version dépendant de leur contenu et de leurs preuves.
- Enregistrer ce qui a été livré et explicitement retenu par le système qui pilote l’agent. « Livré » ne signifie pas « compris » ni « encore présent dans le contexte ».
- Retourner les faits ajoutés, modifiés et rétractés, ainsi que les obligations de vérification invalidées.
- Répéter les obligations critiques actives dans une enveloppe compacte ; ne pas dépendre d’un souvenir implicite du modèle.
- Prévoir acquittement, réinitialisation et récupération d’un paquet complet après perte de session, compaction ou changement de modèle.
- Ajouter un contrat d’import des résultats de vérification : commande, contexte, instantané, statut, preuve de sortie. Un résultat ne reste valide que si les entrées pertinentes et les conditions d’exécution le permettent.
- Intégrer le runner d’agents pour remplacer le contexte actif et demander les preuves à la demande, au lieu d’empiler indéfiniment les réponses.
- Isoler les sessions par dépôt, tâche et client ; borner leur stockage et proposer leur suppression.

**Fichiers :** `core/session/`, `core/context/`, schéma de delta, commande `refresh`, intégration `evals/agent/`.

**Acceptation :** appliquer les deltas reconstruit le même état qu’un nouveau paquet complet ; suppressions et rétractions transmises ; aucune vérification périmée réutilisée ; reprise correcte après oubli de contexte. Mesurer les tokens cumulés de session, pas seulement la taille du delta.

### Lot 7 — expérimenter la représentation et l’analyse sémantique

**Dépendance :** lots 2, 3 et 6.

**Travaux**

- Formaliser un vocabulaire de faits et obligations (`requires`, `forbids`, `depends_on`, `affects`, `verified_by`) avec portée, preuve, conditions et statut d’autorité.
- Réutiliser les assertions et exigences normatives existantes. Une interprétation proposée par l’IA reste une hypothèse tant que les règles d’autorité ne permettent pas sa promotion ; ne pas confondre format structuré et vérité démontrée.
- Comparer JSON compact, lignes typées et format tabulaire sur le même paquet sémantique. Inclure dans le coût l’apprentissage du format, les descriptions d’outils, les appels supplémentaires et les erreurs.
- Choisir une première famille de tâches pour les symboles, par exemple les modifications d’API TypeScript. Extraire les symboles et usages nécessaires à la demande, avec une solution de repli au niveau du composant pour les usages dynamiques ou ambigus.
- Garder les symboles dans un index auxiliaire versionné au début. Les cinq types d’entités normatifs du graphe ne sont pas étendus implicitement.
- Ne réduire une obligation de vérification que lorsqu’une preuve permet cette exclusion. Une classification d’intention ou un score de pertinence ne suffit pas.

**Acceptation :** le format ou l’analyse supplémentaire améliore le résultat sur les tâches réservées et sur les modèles retenus. Sinon, conserver le protocole précédent et retirer l’expérience du chemin par défaut.

**Livraison :** chaque expérience est indépendante et réversible ; aucun langage propriétaire n’est un prérequis des lots antérieurs.

### Lot 8 — optimisation continue contrôlée

**Dépendance :** lot 2 ; chaque variante ne dépend que des fonctionnalités qu’elle modifie.

**Travaux**

- Autoriser un agent d’optimisation à proposer des changements bornés : classement, format, descriptions d’outils, stratégies d’approfondissement.
- Limiter chaque campagne en coût, temps et nombre de variantes ; journaliser configuration et version des candidats.
- Utiliser les tâches de développement pour la recherche et un jeu de validation séparé pour sélectionner les candidats. Réserver un test final aux décisions de livraison ; le renouveler quand des consultations répétées risquent de contaminer l’évaluation.
- Conserver les variantes qui améliorent le compromis réussite/coût/latence. Ne pas modifier automatiquement les obligations, la vérité attendue ou les seuils pour faire accepter une variante.
- Livrer les changements retenus par le processus normal du dépôt, avec mécanisme de retour à la version précédente. Ne pas auto-modifier le moteur en cours de session.

**Acceptation :** une variante nuisible à la fiabilité est rejetée malgré sa brièveté ; les décisions sont reproductibles depuis les artefacts de campagne ; aucune dépendance à un service de modèle n’est requise pour le fonctionnement déterministe courant.

## 5. Mesures et critères de décision

| Mesure | Définition et usage |
|---|---|
| Réussite vérifiée | tâche terminée selon tests et contraintes indépendants d’AgentDoc |
| Coût par réussite | coût de tous les essais, échecs inclus, divisé par le nombre de réussites ; indéfini si aucune réussite |
| Erreurs critiques | obligation manquée, conflit masqué, preuve invalide, mauvais périmètre ou contexte d’exécution |
| Tokens de session | entrées, sorties et raisonnement facturé si disponible ; tokens mis en cache distingués |
| Latence | médiane et p95 des opérations et des tâches ; démarrage à froid séparé des appels répétés |
| Charge locale | lectures, parsings, CPU, mémoire maximale et stockage des caches |
| Coût des checks | temps réel des vérifications sélectionnées ; leur nombre seul ne mesure pas l’économie |

Avant chaque campagne comparative, figer corpus, versions, paramètres, règles de coût, plafond d’essai et critères statistiques. Utiliser une comparaison appariée par tâche et rendre l’incertitude visible. Le pilote de 30 tâches ne suffit pas automatiquement à conclure sur de faibles écarts.

Objectif initial proposé pour la refonte combinée : **réduire d’au moins 20 % le coût par réussite** sur la validation réservée, sans régression de fiabilité établie. Ce seuil est un objectif d’adoption à figer avant les essais, pas un gain déjà observé.

Pour la non-infériorité du taux de réussite, préenregistrer une marge maximale de 2 points et exiger que la borne inférieure de l’intervalle de confiance à 95 % de l’écart reste au-dessus de −2 points. Une nouvelle erreur critique reproductible bloque l’adoption indépendamment de cette marge. Si l’échantillon ne permet pas de conclure, élargir la campagne ou conserver la version de référence ; ne pas conclure à l’équivalence par défaut.

Les correctifs de fidélité restent livrables même s’ils augmentent les tokens. Les optimisations locales peuvent être intégrées si leur bénéfice est mesuré et leur correction démontrée, sans prétendre qu’elles satisfont seules l’objectif global de 20 %.

## 6. Compatibilité, migration et livraison

- Conserver les commandes historiques pendant l’introduction du protocole. Modifier les instructions du skill seulement après validation de son nouveau parcours.
- Versionner séparément graphe, protocole et cache. Un format de cache incompatible peut être abandonné et recalculé ; un graphe incompatible doit être détecté et migré explicitement.
- Toute évolution des champs normatifs du graphe passe par la politique de version de `docs/SPEC.md`. Les schémas fermés existants interdisent les ajouts implicites.
- Pour `prepare`, annoncer explicitement l’utilisation de l’arbre de travail courant. Ne pas modifier silencieusement le contrat de fraîcheur du `query` historique.
- Garder le cœur sans dépendance à une API de modèle. Isoler les dépendances de tokenizer et d’évaluation ; documenter leur version et leur disponibilité. Une nouvelle dépendance de production doit apporter un bénéfice vérifié et apparaître dans le test d’installation du paquet.
- Tester l’installation depuis `npm pack`, la présence des nouveaux schémas et l’absence de dépendances accidentelles aux fichiers du dépôt de développement.
- Mettre à jour `docs/SPEC.md`, `docs/QUERY.md`, `docs/VERIFICATION.md`, `docs/EVALS.md`, `docs/CI.md`, le skill, l’aide CLI et le changelog avec chaque fonctionnalité livrée. Ne pas annoncer une cible comme une capacité déjà présente.
- Garder les tests déterministes sur la matrice Node 22/24/26. Les campagnes de modèles et de performance utilisent des environnements dédiés, épinglés, sans bloquer chaque changement documentaire.

## 7. Ordre d’exécution et suivi

| Livraison | Lots | Condition de passage |
|---|---|---|
| A — fiabilité et référence | 0, 1, 2 | sorties fidèles, tests isolés, runner et référence disponibles |
| B — interface de travail | 3, 4 | paquet multi-chemins, budget vérifié, approfondissement et instantané cohérent |
| C — réutilisation | 5, 6 | équivalence incrémentale et deltas corrects, bénéfices mesurés |
| D — spécialisation | 7, 8 | amélioration confirmée sur validation réservée, retour arrière disponible |

Les lots 1 et 2 peuvent avancer indépendamment après le lot 0. Les lots 5 et 6 peuvent avancer indépendamment après le lot 4. Cet ordre décrit les dépendances ; il n’impose pas d’exécution multi-agent.

- [ ] Lot 0 — mesure et tests reproductibles.
- [ ] Lot 1 — fidélité de toutes les sorties.
- [ ] Lot 2 — évaluation de tâches par agents.
- [ ] Lot 3 — protocole `prepare` / `expand` et budget réel.
- [ ] Lot 4 — instantané, lectures et index partagés.
- [ ] Lot 5 — compilation incrémentale persistante.
- [ ] Lot 6 — mémoire de session et `refresh`.
- [ ] Lot 7 — formats et analyse sémantique expérimentaux.
- [ ] Lot 8 — boucle d’optimisation mesurée.

**Premier changement à implémenter :** isoler la signature Git des fixtures, ajouter les reproductions des omissions Markdown comme tests de régression, puis corriger le rendu. Cette livraison apporte un résultat concret avant d’engager la refonte.

## 8. État de la livraison 1.5.0

| Lot | Résultat livré | Limite empirique ou fonctionnelle explicite |
|---|---|---|
| 0 | Fixtures sans signature héritée, télémétrie et benchmark local reproductible | Mesures locales sur six corpus ; pas de nouvelle campagne des dépôts publics |
| 1 | Sorties Markdown fidèles, omissions et gates visibles, tests CLI | Les budgets historiques restent des plafonds par section |
| 2 | Runner, 30 tâches synthétiques épinglées, driver Codex et smoke réel comparatif | Une tâche, un modèle, une répétition ne prouvent pas un gain général |
| 3 | prepare / expand / refresh, schéma fermé, budget exact, preuves et continuations | Le cwd des checks reste explicitement inconnu quand il n’est pas démontré ; mêmes obligations conservatrices pour chaque intention |
| 4 | Capture cohérente des octets et index partagé dans la préparation | Pas de serveur permanent ni cache des index entre processus |
| 5 | Cache persistant de compilation complète et parsing JSON par contenu | Pas de reconstruction granulaire de tous les extracteurs ; retour au compilateur complet si nécessaire |
| 6 | Deltas, rétractions, état logique complet, preuves d’exécution et nettoyage JS | L’intégration au contexte actif d’un harness externe reste à la charge de son appelant |
| 7 | Faits typés et candidats TypeScript à la demande via API JS | Analyse lexicale partielle ; aucune exclusion de checks ni adoption d’un nouveau format sans mesure |
| 8 | Optimiseur borné, proposeur de variantes déclarées, campagnes dev/holdout et sélection | Aucun gain de 20 % établi, aucune variante promue par le seul smoke ; validation finale indépendante exigée pour toute revendication |

Les cases de la section 7 représentent les acceptations complètes du plan, y compris les campagnes empiriques étendues. La release fournit les mécanismes permettant ces campagnes sans présenter leurs objectifs comme des résultats déjà obtenus. Les nouveaux protocoles sont additifs ; les expériences non validées ne remplacent pas le chemin historique.
