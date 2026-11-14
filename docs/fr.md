# Pstryk

Intégration non officielle pour les clients d'électricité de **Pstryk** en
Pologne, sans lien avec Pstryk. Elle lit vos propres données par l'API
d'intégration officielle de Pstryk (api.pstryk.pl). **Lecture seule** : rien
n'est jamais modifié sur votre compte.

> Cette intégration n'a jamais été testée avec un vrai compte Pstryk : elle a
> été écrite d'après la description officielle de l'API. Merci de signaler ce
> que vous observez (issues GitHub de LM1LC3N7/gladys-pstryk).

## Ce que vous obtenez

- **Un appareil**, « Pstryk », proposé dans la Découverte dès que
  Pstryk a répondu à votre clé :
  - **Prix du kWh actuel (PLN)** et **Prochain prix du kWh (PLN)** : le prix
    brut (TVA incluse) que Pstryk donne pour l'heure en cours et la suivante,
    en złotys par kWh. Gladys n'a pas d'unité złoty : les fonctionnalités
    affichent le nombre seul.
  - **Prix de vente du kWh actuel (PLN, prosommateur)** : le prix que Pstryk
    donne pour l'énergie que vous injectez pendant l'heure en cours, quand il
    en donne un.
  - **Consommation (30 min)** : la consommation de votre compteur, publiée
    après coup pour le suivi énergétique de Gladys. Pstryk donne des heures :
    chaque heure est coupée en deux moitiés égales. L'heure en cours n'est
    jamais publiée.
- **Le modèle de contrat d'énergie « Prix dynamique Pstryk »** : Gladys
  demande à l'intégration le coût de chaque demi-heure ; elle répond la
  consommation multipliée par le prix brut de cette heure. Une heure dont le
  prix est négatif coûte 0 (Gladys n'accepte aucun coût négatif) : le coût
  affiché par Gladys est alors au-dessus de votre facture du crédit, si Pstryk
  en accorde un. L'énergie que vous injectez n'est pas créditée (Gladys ne
  tarifie que la consommation). Les frais fixes mensuels (abonnement, part
  fixe de la distribution, redevance de capacité) sont un montant que vous
  saisissez dans le contrat.

## Mise en place

1. Dans l'**application Pstryk**, créez une **clé d'API** pour les
   intégrations et copiez-la.
2. Dans Gladys, ouvrez la **Configuration** de l'intégration, collez la clé
   et enregistrez. **Tester la connexion** lit avec elle le prix de l'heure en
   cours.
3. Dans la **Découverte**, ajoutez l'appareil « Pstryk électricité ».
4. Dans les réglages énergie, créez un contrat depuis le modèle **Prix
   dynamique Pstryk**, rattaché à la consommation de cet appareil, et
   saisissez vos frais fixes par mois (TVA incluse, d'après votre facture).

La clé d'API est gardée par Gladys dans sa base, jamais réaffichée et envoyée
seulement à Pstryk (api.pstryk.pl), dans l'en-tête `Authorization` de chaque
requête.

## Fréquence des lectures

- Les prix récents (d'hier à la fin de demain) : quand ceux qui sont connus ne
  couvrent pas le reste de la journée (ou, à partir de 14 h heure polonaise,
  toute la journée de demain), au plus une fois par heure. Les prix de demain,
  une fois gardés, sont relus une fois pour les confirmer (3 heures plus tard,
  en visant avant 23 h, au moins une heure plus tard) : les heures pas encore
  commencées prennent les valeurs relues. Puis plus rien avant 14 h le
  lendemain.
- Les prix passés manquants (après un arrêt, une panne) : jusqu'à 31 jours en
  arrière, au plus toutes les 6 heures.
- La consommation, une fois l'appareil ajouté : toutes les 3 heures (les 3
  derniers jours), une fois par jour après 6 h et pour un nouvel appareil les
  7 derniers jours.
- Après une lecture des prix en échec : nouvel essai après 5, 10, 20, 40, puis
  toutes les 60 minutes.
- Pstryk qui demande de ralentir (HTTP 429) : aucune requête pendant la durée
  demandée par son `Retry-After`, sinon 15 minutes, doublées à chaque nouveau
  429 (30, 60, 120…), au plus 6 heures. Pstryk indisponible (5xx) : aucune
  requête pendant 5 minutes, doublées à chaque nouveau 5xx, au plus 6 heures,
  ou au plus 1 heure tant qu'aucun prix de l'heure en cours n'est connu (une
  panne qui dure après minuit). Les pauses sont gardées d'un redémarrage à
  l'autre : après une longue panne, la lecture suivante peut attendre jusqu'à
  6 heures.
- Un redémarrage, la Découverte ou l'enregistrement de la configuration ne
  lisent jamais plus tôt que ces intervalles (une nouvelle clé est lue après 1
  minute). Quand `/data` est illisible au démarrage, les dernières lectures
  sont inconnues : la première lecture attend 5 minutes. Une requête à la
  fois, espacées d'au moins 2 secondes.

## Ce que sont les prix

Pour chaque heure, l'API de Pstryk donne le prix brut du kWh de votre contrat
(`price_gross`, TVA incluse). L'intégration le garde tel quel. Ce qu'il
comprend (l'énergie seule, ou aussi la part variable de la distribution et
l'accise) n'est pas encore confirmé sur un vrai compte : s'il laisse de côté
la part variable de la distribution, le coût affiché par Gladys est sous votre
facture. Les prix des heures passées sont gardés 40 jours dans `/data`, pour
que Gladys puisse tarifer les intervalles passés ; un intervalle plus ancien
que les prix gardés (un contrat créé avec une date de début lointaine) n'a pas
de coût. Le modèle ne sert qu'au prix dynamique de Pstryk : un contrat à prix
fixe (le même prix chaque heure) n'est jamais tarifé.

Un prix inconnu n'est jamais compté 0 (une demi-heure sans consommation coûte
0 quel que soit le prix). Les prix provisoires sont écartés par une règle qui
n'est pas confirmée sur un vrai compte : une journée polonaise n'est gardée
qu'entière (chacune de ses heures a un prix, 23 ou 25 les jours de changement
d'heure) et sans une même valeur répétée sur plus de 90 % de ses heures (ce
que Pstryk peut répondre avant la publication des prix de demain) ; une
réponse provisoire qui passe cette règle est remplacée par la lecture de
confirmation dans les heures pas encore commencées si Pstryk donne les vrais
prix d'ici là (quand cette lecture ne rend plus la journée entière, ses heures
à venir sont retirées et relues chaque heure jusqu'à une journée entière) ;
une heure déjà commencée garde le prix gardé pour elle. Une réponse
provisoire qui dure au-delà de la confirmation est gardée telle quelle. Quand
une heure d'une période de facturation n'a pas de prix, toute la demande de
Gladys pour cette période échoue et aucun coût n'est enregistré tant que le
prix n'est pas connu : l'intégration relit les jours passés manquants
(jusqu'à 31 jours en arrière, au plus toutes les 6 heures), par exemple après
un arrêt de Gladys ; un jour que Pstryk ne donne jamais laisse ces coûts vides.

Une autre clé d'API (peut-être un autre compte, avec un autre tarif de
distribution) efface les prix connus et les relit. Après un redémarrage, les
prix gardés dans `/data` restent quelle que soit la clé : changez la clé
pendant que Gladys tourne.

## Messages

- _Pstryk a refusé la clé d'API_ : Pstryk a répondu 401 ou 403 en disant que
  la clé est mauvaise (« Incorrect authentication credentials. »). Plus rien
  n'est envoyé tant que vous ne changez pas la clé ou que le bouton
  **Tester** ne réussit pas. Toute autre réponse (un 403 qui dit autre chose,
  une réponse illisible, un 404, un 5xx) n'est jamais prise pour un refus :
  elle est réessayée plus tard.
- _Aucun prix d'aujourd'hui n'est encore connu_ : le contrat d'énergie n'est
  pas tarifé en attendant.
- _Pstryk n'a pas donné de prix complets pour certains jours passés_ :
  certains des 31 derniers jours n'ont pas pu être complétés. Les prix
  d'aujourd'hui et de demain ne sont pas touchés ; les coûts de la période de
  facturation de ces jours restent vides (redemandés toutes les 6 heures).
- _Consommation non lue_ : les prix continuent ; la consommation est
  redemandée 3 heures plus tard.

## Confidentialité

La clé d'API n'est jamais écrite dans un journal, le statut ni `/data`.
`/data` garde les heures des dernières lectures, la pause, les prix horaires et
une marque de clé refusée (8 bits d'une empreinte salée, rien qui permette de
retrouver la clé). L'identifiant de l'appareil ne contient rien de la clé, du
compteur ni du client.
