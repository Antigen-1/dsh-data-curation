;; Experimental R6RS project-library / plugin loader for the Chez Wasm spike.
;; This is not a production loader. It deliberately evaluates only R6RS
;; `library` forms and keeps project code out of `interaction-environment`
;; during calls: the interaction environment is used solely to register a
;; library form, then every plugin call runs through an immutable `environment`.
(import (chezscheme))

(load "/source-tree-reader.scm")

;; ---------------------------------------------------------------------------
;; Safe dynamic evaluation surface
;; ---------------------------------------------------------------------------

;; Project code may use `(rnrs eval)` for `eval`/`environment`, but the raw
;; Chez `environment` can import `(chezscheme)` and bypass the static allowlist.
;; This wrapper is installed by rewriting project imports to `(dsh safe eval (6))`.
(define SAFE-EVAL-SOURCE
  (string-append
    "(library (dsh safe eval (6))\n"
    "  (export eval environment)\n"
    "  (import (rnrs base (6)) (rnrs lists (6))\n"
    "          (rename (rnrs eval (6)) (eval raw-eval) (environment raw-environment)))\n"
    "  (define allowed\n"
    "    '((rnrs base (6)) (rnrs arithmetic bitwise (6)) (rnrs arithmetic fixnums (6))\n"
    "      (rnrs arithmetic flonums (6)) (rnrs bytevectors (6)) (rnrs conditions (6))\n"
    "      (rnrs control (6)) (rnrs enums (6)) (rnrs exceptions (6)) (rnrs files (6))\n"
    "      (rnrs hashtables (6)) (rnrs io ports (6)) (rnrs io simple (6)) (rnrs lists (6))\n"
    "      (rnrs mutable-pairs (6)) (rnrs mutable-strings (6)) (rnrs programs (6))\n"
    "      (rnrs r5rs (6)) (rnrs records procedural (6)) (rnrs records syntactic (6))\n"
    "      (rnrs records inspection (6)) (rnrs sorting (6)) (rnrs syntax-case (6))\n"
    "      (rnrs unicode (6))))\n"
    "  (define (allowed-spec? spec)\n"
    "    (or (member spec allowed)\n"
    "        (and (pair? spec) (eq? (car spec) 'dsh))))\n"
    "  (define (check-spec spec)\n"
    "    (cond ((and (pair? spec) (memq (car spec) '(only except prefix rename for)))\n"
    "           (check-spec (cadr spec)))\n"
    "          ((allowed-spec? spec) #t)\n"
    "          (else (assertion-violation 'environment \"library import denied\" spec))))\n"
    "  (define (environment . specs)\n"
    "    (for-each check-spec specs)\n"
    "    (apply raw-environment specs))\n"
    "  (define (eval expr env) (raw-eval expr env)))\n"))

(eval (read (open-input-string SAFE-EVAL-SOURCE)) (interaction-environment))

;; ---------------------------------------------------------------------------
;; Errors and descriptors
;; ---------------------------------------------------------------------------

(define-condition-type &plugin-error &condition
  make-plugin-error plugin-error?
  (code plugin-error-code))

(define (plugin-error code . detail)
  (raise (make-plugin-error code)))

(define (desc-form d) (vector-ref d 0))
(define (desc-name d) (vector-ref d 1))
(define (desc-kind d) (vector-ref d 2))
(define (desc-id d) (vector-ref d 3))
(define (desc-version d) (vector-ref d 4))
(define (desc-exports d) (vector-ref d 5))
(define (desc-imports d) (vector-ref d 6))
(define (desc-body d) (vector-ref d 7))
(define (desc-tree d) (vector-ref d 8))

(define (library-name? x)
  (and (list? x) (>= (length x) 1)))

(define (same-name? a b) (equal? a b))

;; ---------------------------------------------------------------------------
;; Standard library allowlist
;; ---------------------------------------------------------------------------

(define STANDARD-LIBRARIES
  '((rnrs base (6))
    (rnrs arithmetic bitwise (6))
    (rnrs arithmetic fixnums (6))
    (rnrs arithmetic flonums (6))
    (rnrs bytevectors (6))
    (rnrs conditions (6))
    (rnrs control (6))
    (rnrs enums (6))
    (rnrs eval (6))
    (rnrs exceptions (6))
    (rnrs files (6))
    (rnrs hashtables (6))
    (rnrs io ports (6))
    (rnrs io simple (6))
    (rnrs lists (6))
    (rnrs mutable-pairs (6))
    (rnrs mutable-strings (6))
    (rnrs programs (6))
    (rnrs r5rs (6))
    (rnrs records procedural (6))
    (rnrs records syntactic (6))
    (rnrs records inspection (6))
    (rnrs sorting (6))
    (rnrs syntax-case (6))
    (rnrs unicode (6))
    (dsh safe eval (6))
    (dsh ffi (6))
    (rnrs (6))))

(define (standard-library? name)
  (and (member name STANDARD-LIBRARIES) #t))

;; ---------------------------------------------------------------------------
;; Import validation
;; ---------------------------------------------------------------------------

(define (import-wrapper? x)
  (and (pair? x) (memq (car x) '(only except prefix rename for))))

(define (validate-import-set! spec allowed)
  (cond
    ((import-wrapper? spec)
     (when (< (length spec) 2)
       (plugin-error 'E-IMPORT-SYNTAX spec))
     (validate-import-set! (cadr spec) allowed)
     (case (car spec)
       ((only except) (for-each (lambda (x) (unless (symbol? x) (plugin-error 'E-IMPORT-SYNTAX x))) (cddr spec)))
       ((prefix) (unless (and (= (length spec) 3) (symbol? (caddr spec))) (plugin-error 'E-IMPORT-SYNTAX spec)))
       ((rename) (for-each (lambda (x) (unless (and (list? x) (= (length x) 2) (symbol? (car x)) (symbol? (cadr x))) (plugin-error 'E-IMPORT-SYNTAX x))) (cddr spec)))
       ((for) (unless (>= (length spec) 3) (plugin-error 'E-IMPORT-SYNTAX spec)))))
    ((library-name? spec)
     (unless (or (standard-library? spec) (member spec allowed))
       (plugin-error 'E-IMPORT-DENIED spec)))
    (else
     (plugin-error 'E-IMPORT-SYNTAX spec))))

(define (validate-imports! imports allowed)
  (for-each (lambda (spec) (validate-import-set! spec allowed)) imports))

(define (rewrite-import-spec spec)
  (cond
    ((import-wrapper? spec)
     (cons (car spec) (cons (rewrite-import-spec (cadr spec)) (cddr spec))))
    ((equal? spec '(rnrs eval (6))) '(dsh safe eval (6)))
    ((equal? spec '(rnrs (6)))
     (plugin-error 'E-IMPORT-DENIED
       "(rnrs (6)) is not exposed to project plugins; import explicit libraries"))
    (else spec)))

;; ---------------------------------------------------------------------------
;; Library parsing
;; ---------------------------------------------------------------------------

(define (parse-export-spec spec)
  (cond
    ((symbol? spec) spec)
    ((and (list? spec) (= (length spec) 2) (eq? (car spec) 'rename)
          (list? (cadr spec)) (= (length (cadr spec)) 2)
          (symbol? (car (cadr spec))) (symbol? (cadr (cadr spec))))
     (cadr (cadr spec)))
    (else (plugin-error 'E-EXPORT-SYNTAX spec))))

(define (parse-library source)
  (let ((forms (read-source source)))
    (unless (= (length forms) 1)
      (plugin-error 'E-PLUGIN-FORM-COUNT "exactly one library form is required"))
    (let* ((form (car forms)))
      (unless (and (list? form) (>= (length form) 4) (eq? (car form) 'library))
        (plugin-error 'E-PLUGIN-FORM-SHAPE "expected (library ...)"))
      (let* ((name (cadr form))
             (export-clause (caddr form))
             (import-clause (cadddr form))
             (body (cddddr form)))
        (unless (and (list? name) (>= (length name) 2))
          (plugin-error 'E-LIBRARY-NAME name))
        (unless (and (list? export-clause) (eq? (car export-clause) 'export))
          (plugin-error 'E-EXPORT-CLAUSE export-clause))
        (unless (and (list? import-clause) (eq? (car import-clause) 'import))
          (plugin-error 'E-IMPORT-CLAUSE import-clause))
        (let* ((exports (map parse-export-spec (cdr export-clause)))
               (imports (map rewrite-import-spec (cdr import-clause)))
               (rewritten-form
                (append (list 'library name export-clause (cons 'import imports)) body))
               (kind
                (cond
                  ((and (= (length name) 4) (eq? (list-ref name 0) 'dsh)
                        (eq? (list-ref name 1) 'plugin)) 'plugin)
                  ((and (= (length name) 4) (eq? (list-ref name 0) 'dsh)
                        (eq? (list-ref name 1) 'lib)) 'project-library)
                  (else 'other)))
               (id (if (memq kind '(plugin project-library)) (list-ref name 2) #f))
               (version (if (memq kind '(plugin project-library)) (list-ref name 3) #f)))
          (when (memq kind '(plugin project-library))
            (unless (and (symbol? id) (symbol? version))
              (plugin-error 'E-LIBRARY-NAME name)))
          (when (and (eq? kind 'plugin) (not (pair? exports)))
            (plugin-error 'E-EXPORT-CLAUSE "plugin must export at least one name"))
          (vector rewritten-form name kind id version exports imports body (tree-hash source)))))))

;; ---------------------------------------------------------------------------
;; Bundle hash (experimental canonical record)
;; ---------------------------------------------------------------------------

(define BUNDLE-DOMAIN
  (string->utf8 (string-append "dsh/source-bundle/v2" (string (integer->char 0)))))

(define (name-string name)
  (with-output-to-string (lambda () (write name))))

(define (desc-version-string d)
  (let ((v (desc-version d)))
    (if (symbol? v) (symbol->string v) "")))

(define (sort-descs descs)
  (define (insert d rest)
    (cond ((null? rest) (list d))
          ((string<? (name-string (desc-name d)) (name-string (desc-name (car rest))))
           (cons d rest))
          (else (cons (car rest) (insert d (cdr rest))))))
  (let loop ((xs descs) (out '()))
    (if (null? xs) out (loop (cdr xs) (insert (car xs) out)))))

(define (import-base-spec spec)
  (if (pair? spec)
      (let ((head (car spec)))
        (if (memq head '(only except prefix rename for))
            (import-base-spec (cadr spec))
            spec))
      spec))

(define (project-import-names imports)
  (define (walk xs)
    (if (null? xs)
        '()
        (let ((base (import-base-spec (car xs))))
          (if (and (pair? base)
                   (eq? (car base) 'dsh)
                   (not (equal? base '(dsh safe eval (6))))
                   (not (equal? base '(dsh ffi (6)))))
              (cons (name-string base) (walk (cdr xs)))
              (walk (cdr xs))))))
  (let ((unique
         (let loop ((xs (walk imports)) (out '()))
           (cond ((null? xs) out)
                 ((member (car xs) out) (loop (cdr xs) out))
                 (else (loop (cdr xs) (cons (car xs) out)))))))
    (let loop ((xs unique) (out '()))
      (if (null? xs)
          out
          (let ((x (car xs)))
            (let insert ((ys out) (before '()))
              (cond ((null? ys) (append out (list x)))
                    ((string<? x (car ys))
                     (append (reverse before) (cons x ys)))
                    (else (insert (cdr ys) (cons (car ys) before))))))))))

(define (bundle-hash descs)
  (let* ((datum (cons 'bundle
                      (map (lambda (d)
                             (list 'module
                                   (name-string (desc-name d))
                                   (desc-version-string d)
                                   (desc-tree d)
                                   (project-import-names (desc-imports d))))
                           (sort-descs descs))))
         (bytes
          (let-values (((out get) (open-bytevector-output-port)))
            (emit-datum out datum)
            (get))))
    (bytevector->hex
      (sha256 (concat-bv BUNDLE-DOMAIN bytes)))))

;; ---------------------------------------------------------------------------
;; Registry
;; ---------------------------------------------------------------------------

(define libraries '())
(define plugins '())
(define last-bundle-descs '())
(define vm-poisoned? #f)
(define load-eval-started? #f)

(define (loaded-bundle-descs) last-bundle-descs)

(define (poison-vm!)
  (set! vm-poisoned? #t))

(define (ensure-live-vm!)
  (when vm-poisoned?
    (plugin-error 'E-VM-POISONED "restart the incarnation after a failed load")))

(define (library-ref name)
  (let ((cell (assoc name libraries))) (and cell (cdr cell))))

(define (plugin-ref id)
  (let ((cell (assoc id plugins))) (and cell (cdr cell))))

(define (plugin-count) (length plugins))
(define (library-count) (length libraries))

(define (try thunk)
  (call/cc
    (lambda (escape)
      (with-exception-handler
        (lambda (e) (escape (cons 'error e)))
        (lambda () (cons 'value (thunk)))))))

(define (check-exports! desc env)
  (for-each
    (lambda (name)
      (let ((r (try (lambda () (eval name env)))))
        (if (eq? (car r) 'error)
            (plugin-error 'E-EXPORT-MISSING name)
            (let ((value (cdr r)))
              (unless (procedure? value)
                (plugin-error 'E-EXPORT-NOT-PROCEDURE name))))))
    (desc-exports desc)))

;; A Chez library form is registered globally by eval, so a failed evaluation
;; cannot be rolled back without discarding the whole VM. Keep our own registry
;; transactional, and poison the VM after any evaluation-side failure so a
;; later load cannot observe a half-installed bundle.
(define (install-one! desc bundle)
  (when (library-ref (desc-name desc))
    (plugin-error 'E-DUPLICATE-LIBRARY (desc-name desc)))
  (when (and (eq? (desc-kind desc) 'plugin) (plugin-ref (desc-id desc)))
    (plugin-error 'E-DUPLICATE-PLUGIN (desc-id desc)))
  (set! load-eval-started? #t)
  (let ((load-result (try (lambda () (eval (desc-form desc) (interaction-environment))))))
    (when (eq? (car load-result) 'error)
      (plugin-error (classify-error (cdr load-result)) (desc-name desc))))
  (let ((env-result (try (lambda () (environment (desc-name desc))))))
    (when (eq? (car env-result) 'error)
      (plugin-error 'E-EXPORT-MISSING (desc-name desc)))
    (let ((env (cdr env-result)))
      (check-exports! desc env)
      (list (desc-name desc) (desc-id desc) (desc-version desc)
            (desc-tree desc) bundle (desc-exports desc) env))))

(define (error-text e)
  (guard (e2 (#t ""))
    (if (condition? e) (condition-message e) "")))

(define (string-contains? text needle)
  (let ((n (string-length text))
        (m (string-length needle)))
    (let loop ((i 0))
      (cond ((> (+ i m) n) #f)
            ((string=? (substring text i (+ i m)) needle) #t)
            (else (loop (+ i 1)))))))

(define (classify-error e)
  (let ((message (error-text e)))
    (cond
      ((and (string? message) (string-contains? message "export")) 'E-EXPORT-MISSING)
      ((and (string? message) (string-contains? message "not bound")) 'E-EXPORT-MISSING)
      (else 'E-LOAD))))

(define (load-bundle! sources)
  (ensure-live-vm!)
  (let ((old-libraries libraries)
        (old-plugins plugins))
    (set! load-eval-started? #f)
    (let ((result
           (try
            (lambda ()
              (let* ((descs (map parse-library sources))
                     (names (map desc-name descs)))
                (for-each
                  (lambda (d)
                    (when (eq? (desc-kind d) 'other)
                      (plugin-error 'E-LIBRARY-NAME (desc-name d))))
                  descs)
                (for-each
                  (lambda (name)
                    (when (or (member name (cdr (member name names)))
                              (library-ref name))
                      (plugin-error 'E-DUPLICATE-LIBRARY name)))
                  names)
                (let ((seen-ids '()))
                  (for-each
                    (lambda (d)
                      (when (eq? (desc-kind d) 'plugin)
                        (when (or (member (desc-id d) seen-ids) (plugin-ref (desc-id d)))
                          (plugin-error 'E-DUPLICATE-PLUGIN (desc-id d)))
                        (set! seen-ids (cons (desc-id d) seen-ids))))
                    descs))
                (for-each
                  (lambda (d) (validate-imports! (desc-imports d) names))
                  descs)
                (let* ((bundle (bundle-hash descs))
                       (entries (map (lambda (d) (install-one! d bundle)) descs))
                       (library-entries
                        (map (lambda (d entry) (cons (desc-name d) entry)) descs entries))
                       (plugin-entries
                        (let loop ((ds descs) (es entries) (out '()))
                          (cond ((null? ds) (reverse out))
                                ((eq? (desc-kind (car ds)) 'plugin)
                                 (loop (cdr ds) (cdr es)
                                       (cons (cons (desc-id (car ds)) (car es)) out)))
                                (else (loop (cdr ds) (cdr es) out))))))
                  ;; Publish our registry only after every library evaluated and
                  ;; every export checked. Chez's global library namespace is not
                  ;; transactional; a late failure poisons the incarnation.
                  (set! libraries (append library-entries libraries))
                  (set! plugins (append plugin-entries plugins))
                  (set! last-bundle-descs descs)
                  bundle))))))
      (if (eq? (car result) 'error)
          (begin
            (set! libraries old-libraries)
            (set! plugins old-plugins)
            (when load-eval-started? (poison-vm!))
            (let ((e (cdr result)))
              (if (plugin-error? e)
                  (raise e)
                  (plugin-error (classify-error e) e))))
          (cdr result)))))

(define (load-plugin-source! source . expected-tree)
  (let ((desc (parse-library source)))
    (when (and (pair? expected-tree)
               (not (string=? (desc-tree desc) (car expected-tree))))
      (plugin-error 'E-TREE-HASH-MISMATCH (desc-tree desc)))
    (let ((bundle (load-bundle! (list source))))
      (list (desc-id desc) (desc-version desc) (desc-tree desc) bundle))))

(define (plugin-call id name . args)
  (ensure-live-vm!)
  (let* ((entry (plugin-ref id))
         (env (and entry (list-ref entry 6))))
    (if (not entry)
        (plugin-error 'E-UNKNOWN-PLUGIN id))
    (let ((result (try (lambda () (eval name env)))))
      (if (eq? (car result) 'error)
          (plugin-error 'E-UNKNOWN-EXPORT name)
          (let ((proc (cdr result)))
            (if (not (procedure? proc))
                (plugin-error 'E-UNKNOWN-EXPORT name)
                (let ((called (try (lambda () (apply proc args)))))
                  (if (eq? (car called) 'error)
                      (let ((e (cdr called)))
                        (if (and (condition? e)
                                 (string-contains? (condition-message e) "library import denied"))
                            (plugin-error 'E-IMPORT-DENIED name)
                            (plugin-error 'E-PLUGIN-CALL name)))
                      (cdr called)))))))))
