# Verifio Tickets

Application personnelle de création de liens de vérification et de suivi des tickets. Elle utilise Node.js (24+) et SQLite intégré, sans dépendance externe. Les tables `verification_links`, `reference_tickets` et `verification_logs` sont stockées dans `data/verifio.sqlite`.

## Démarrer

Lancer `start-verifio.bat` par double-clic, ou exécuter `npm start` dans ce dossier.

Ouvrir `http://localhost:3000`. Au premier démarrage, le code privé du Dashboard est généré dans `data/admin-code.txt` et affiché dans le terminal. Gardez ce code privé. Pour choisir un code personnel, définir `VERIFIO_ADMIN_CODE` avant le démarrage. `PUBLIC_URL` définit le domaine des liens générés en production; `PORT` définit le port d’écoute. Le répertoire `data/` contient les données et n’est pas versionné.

## Utilisation

- Le Dashboard est disponible à `/` et protégé par un code personnel. Sa session dure sept jours; le bouton « Verrouiller » ferme la session.
- Chaque lien public utilise `/verify/{identifiant}.{jeton}`. Il peut être partagé sans exposer les données du Dashboard.
- Le système crée automatiquement 100 tickets de référence de 12 caractères à l’initialisation. Les 20 premiers sont expirés et les 80 autres ont une date future afin de pouvoir éprouver les deux états.
- Le résultat valide exige une correspondance du code **et** de la date d’expiration. Chaque soumission est journalisée, y compris les codes inconnus.
- Les sauvegardes locales peuvent être effectuées en copiant le dossier `data/` lorsque le serveur est arrêté.
- Les installations antérieures utilisant `data/store.json` sont importées automatiquement.

## Mise en production

Définir `NODE_ENV=production`, `VERIFIO_ADMIN_CODE`, `VERIFIO_SESSION_SECRET`, `PUBLIC_URL` et `PORT`. Utiliser un hébergement Node avec stockage persistant et HTTPS. SQLite convient à une instance unique et à un trafic personnel modéré.
