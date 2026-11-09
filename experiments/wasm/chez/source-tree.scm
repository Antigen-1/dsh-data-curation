;; Experimental source-tree identity for Chez Scheme.
;; Public Chez/R6RS procedures only. No interpreter/compiler changes.
(import (chezscheme))

;; ---------------------------------------------------------------------------
;; Small deterministic byte encoder
;; ---------------------------------------------------------------------------

(define (u8 n) (list (bitwise-and n #xFF)))
(define (u16 n) (list (bitwise-and (bitwise-arithmetic-shift-right n 8) #xFF)
                      (bitwise-and n #xFF)))
(define (u32 n) (list (bitwise-and (bitwise-arithmetic-shift-right n 24) #xFF)
                      (bitwise-and (bitwise-arithmetic-shift-right n 16) #xFF)
                      (bitwise-and (bitwise-arithmetic-shift-right n 8) #xFF)
                      (bitwise-and n #xFF)))
(define (list->bv xs)
  (let* ((n (length xs)) (bv (make-bytevector n 0)))
    (let loop ((i 0) (rest xs))
      (if (= i n) bv
          (begin
            (bytevector-u8-set! bv i (car rest))
            (loop (+ i 1) (cdr rest)))))))
(define (bytes-of-string s)
  (let* ((bv (string->utf8 s)) (n (bytevector-length bv)))
    (let loop ((i 0) (out '()))
      (if (= i n) (reverse out)
          (loop (+ i 1) (cons (bytevector-u8-ref bv i) out))))))
(define (bytes-of-bv bv)
  (let ((n (bytevector-length bv)))
    (let loop ((i 0) (out '()))
      (if (= i n) (reverse out)
          (loop (+ i 1) (cons (bytevector-u8-ref bv i) out))))))
(define (tagged tag payload) (append (u8 tag) payload))
(define (len-prefixed tag s)
  (let ((bs (bytes-of-string s)))
    (tagged tag (append (u32 (length bs)) bs))))
(define (integer-bytes n)
  (let* ((negative? (< n 0))
         (magnitude (if negative? (- n) n))
         (digits (string->utf8 (number->string magnitude 10))))
    (tagged #x04
      (append (u8 (if negative? 1 0))
              (u32 (bytevector-length digits))
              (bytes-of-bv digits)))))

(define (encode-datum v)
  (cond
    ((eq? v #t) (tagged #x07 (u8 1)))
    ((eq? v #f) (tagged #x07 (u8 0)))
    ((null? v) (tagged #x01 (u32 0)))
    ((integer? v) (integer-bytes v))
    ((and (number? v) (rational? v) (not (integer? v)))
     (tagged #x05
       (append (integer-bytes (numerator v)) (integer-bytes (denominator v)))))
    ((and (number? v) (real? v) (inexact? v))
     (tagged #x06 (len-prefixed #x00 (number->string v))))
    ((symbol? v) (len-prefixed #x02 (symbol->string v)))
    ((string? v) (len-prefixed #x03 v))
    ((char? v) (tagged #x08 (u32 (char->integer v))))
    ((bytevector? v)
     (let ((bs (bytes-of-bv v)))
       (tagged #x0A (append (u32 (length bs)) bs))))
    ((vector? v)
     (let* ((xs (vector->list v))
            (parts (map encode-datum xs)))
       (tagged #x09 (append (u32 (length xs)) (apply append parts)))))
    ((pair? v)
     (if (list? v)
         (let ((parts (map encode-datum v)))
           (tagged #x01 (append (u32 (length v)) (apply append parts))))
         (error 'unsupported-dotted-list v)))
    ((number? v) (error 'unsupported-number v))
    (else (error 'unsupported-datum v))))

(define (read-all source)
  (let ((port (open-input-string source)))
    (let loop ((out '()))
      (let ((datum (read port)))
        (if (eof-object? datum)
            (reverse out)
            (loop (cons datum out)))))))

(define (encode-source-tree source)
  (let* ((forms (read-all source))
         (parts (map encode-datum forms)))
    (tagged #x10
      (append (u32 (length forms)) (apply append parts)))))

(define (canonical-source-bytes source)
  (list->bv (encode-source-tree source)))

;; ---------------------------------------------------------------------------
;; SHA-256 (public R6RS bytevector operations)
;; ---------------------------------------------------------------------------

(define MASK #xFFFFFFFF)
(define (u32x n) (bitwise-and n MASK))
(define (add32 . xs) (u32x (apply + xs)))
(define (rotr x n)
  (u32x (bitwise-ior
          (bitwise-arithmetic-shift-right x n)
          (bitwise-arithmetic-shift-left x (- 32 n)))))
(define (shr x n) (bitwise-arithmetic-shift-right x n))
(define (xor3 a b c) (bitwise-xor (bitwise-xor a b) c))
(define (ch x y z) (bitwise-xor (bitwise-and x y) (bitwise-and (bitwise-not x) z)))
(define (maj x y z) (bitwise-xor (bitwise-xor (bitwise-and x y) (bitwise-and x z)) (bitwise-and y z)))

(define K
  (vector
   #x428a2f98 #x71374491 #xb5c0fbcf #xe9b5dba5 #x3956c25b #x59f111f1 #x923f82a4 #xab1c5ed5
   #xd807aa98 #x12835b01 #x243185be #x550c7dc3 #x72be5d74 #x80deb1fe #x9bdc06a7 #xc19bf174
   #xe49b69c1 #xefbe4786 #x0fc19dc6 #x240ca1cc #x2de92c6f #x4a7484aa #x5cb0a9dc #x76f988da
   #x983e5152 #xa831c66d #xb00327c8 #xbf597fc7 #xc6e00bf3 #xd5a79147 #x06ca6351 #x14292967
   #x27b70a85 #x2e1b2138 #x4d2c6dfc #x53380d13 #x650a7354 #x766a0abb #x81c2c92e #x92722c85
   #xa2bfe8a1 #xa81a664b #xc24b8b70 #xc76c51a3 #xd192e819 #xd6990624 #xf40e3585 #x106aa070
   #x19a4c116 #x1e376c08 #x2748774c #x34b0bcb5 #x391c0cb3 #x4ed8aa4a #x5b9cca4f #x682e6ff3
   #x748f82ee #x78a5636f #x84c87814 #x8cc70208 #x90befffa #xa4506ceb #xbef9a3f7 #xc67178f2))

(define (pad-message bv)
  (let* ((len (bytevector-length bv))
         (rem (modulo len 64))
         (pad-len (if (< rem 56) (- 55 rem) (- 119 rem)))
         (total (+ len 1 pad-len 8))
         (out (make-bytevector total 0)))
    (let loop ((i 0))
      (when (< i len)
        (bytevector-u8-set! out i (bytevector-u8-ref bv i))
        (loop (+ i 1))))
    (bytevector-u8-set! out len #x80)
    (let ((bits (* len 8)))
      (let loop ((i 0))
        (when (< i 8)
          (bytevector-u8-set! out (- total 1 i)
            (bitwise-and (bitwise-arithmetic-shift-right bits (* 8 i)) #xFF))
          (loop (+ i 1)))))
    out))

(define (sha256 bv)
  (let* ((msg (pad-message bv))
         (n (/ (bytevector-length msg) 64))
         (h (vector #x6a09e667 #xbb67ae85 #x3c6ef372 #xa54ff53a
                    #x510e527f #x9b05688c #x1f83d9ab #x5be0cd19)))
    (let chunk-loop ((chunk 0))
      (if (= chunk n)
          (let loop ((i 0) (out '()))
            (if (= i 8) (list->bv (reverse out))
                (let ((word (vector-ref h i)))
                  (loop (+ i 1)
                        (append (reverse (u32 word)) out)))))
          (let ((w (make-vector 64 0))
                (base (* chunk 64)))
            (let loop ((i 0))
              (when (< i 16)
                (let ((j (+ base (* i 4))))
                  (vector-set! w i
                    (bitwise-ior
                      (bitwise-arithmetic-shift-left (bytevector-u8-ref msg j) 24)
                      (bitwise-arithmetic-shift-left (bytevector-u8-ref msg (+ j 1)) 16)
                      (bitwise-arithmetic-shift-left (bytevector-u8-ref msg (+ j 2)) 8)
                      (bytevector-u8-ref msg (+ j 3)))))
                (loop (+ i 1))))
            (let loop ((i 16))
              (when (< i 64)
                (vector-set! w i
                  (add32 (vector-ref w (- i 16))
                         (u32x (bitwise-xor
                                 (rotr (vector-ref w (- i 15)) 7)
                                 (rotr (vector-ref w (- i 15)) 18)
                                 (shr (vector-ref w (- i 15)) 3)))
                         (vector-ref w (- i 7))
                         (u32x (bitwise-xor
                                 (rotr (vector-ref w (- i 2)) 17)
                                 (rotr (vector-ref w (- i 2)) 19)
                                 (shr (vector-ref w (- i 2)) 10)))))
                (loop (+ i 1))))
            (let ((a (vector-ref h 0)) (b (vector-ref h 1))
                  (c (vector-ref h 2)) (d (vector-ref h 3))
                  (e (vector-ref h 4)) (f (vector-ref h 5))
                  (g (vector-ref h 6)) (hh (vector-ref h 7)))
              (let loop ((i 0))
                (when (< i 64)
                  (let* ((s1 (u32x (bitwise-xor (rotr e 6) (rotr e 11) (rotr e 25))))
                         (chv (ch e f g))
                         (t1 (add32 hh s1 chv (vector-ref K i) (vector-ref w i)))
                         (s0 (u32x (bitwise-xor (rotr a 2) (rotr a 13) (rotr a 22))))
                         (majv (maj a b c))
                         (t2 (add32 s0 majv)))
                    (set! hh g) (set! g f) (set! f e)
                    (set! e (add32 d t1))
                    (set! d c) (set! c b) (set! b a)
                    (set! a (add32 t1 t2)))
                  (loop (+ i 1))))
              (vector-set! h 0 (add32 (vector-ref h 0) a))
              (vector-set! h 1 (add32 (vector-ref h 1) b))
              (vector-set! h 2 (add32 (vector-ref h 2) c))
              (vector-set! h 3 (add32 (vector-ref h 3) d))
              (vector-set! h 4 (add32 (vector-ref h 4) e))
              (vector-set! h 5 (add32 (vector-ref h 5) f))
              (vector-set! h 6 (add32 (vector-ref h 6) g))
              (vector-set! h 7 (add32 (vector-ref h 7) hh)))
            (chunk-loop (+ chunk 1)))))))

(define (bytevector->hex bv)
  (let ((digits "0123456789abcdef"))
    (let loop ((i 0) (out '()))
      (if (= i (bytevector-length bv))
          (list->string (reverse out))
          (let ((b (bytevector-u8-ref bv i)))
            (loop (+ i 1)
                  (cons (string-ref digits (bitwise-and b #xF))
                        (cons (string-ref digits (bitwise-and (bitwise-arithmetic-shift-right b 4) #xF)) out))))))))

(define TREE_DOMAIN
  (string->utf8 (string-append "dsh/rule-tree/v1" (string (integer->char 0)))))

(define (concat-bv a b)
  (let* ((an (bytevector-length a)) (bn (bytevector-length b))
         (out (make-bytevector (+ an bn) 0)))
    (let loop ((i 0))
      (when (< i an)
        (bytevector-u8-set! out i (bytevector-u8-ref a i))
        (loop (+ i 1))))
    (let loop ((i 0))
      (when (< i bn)
        (bytevector-u8-set! out (+ an i) (bytevector-u8-ref b i))
        (loop (+ i 1))))
    out))

(define (tree-hash source)
  (bytevector->hex
    (sha256 (concat-bv TREE_DOMAIN (canonical-source-bytes source)))))

;; ---------------------------------------------------------------------------
;; Experimental source registration and pure-Scheme plugins
;; ---------------------------------------------------------------------------

(define rules '())
(define plugins '())

(define (rule-ref id)
  (let ((cell (assoc id rules))) (and cell (cdr cell))))
(define (plugin-ref id)
  (let ((cell (assoc id plugins))) (and cell (cdr cell))))

(define (register-plugin! id version api)
  (when (plugin-ref id) (error 'duplicate-plugin id))
  (when (not (list? api)) (error 'invalid-plugin-api id))
  (set! plugins (cons (list id version api) plugins))
  id)

(define (plugin-call id name . args)
  (let* ((plugin (plugin-ref id))
         (api (and plugin (cadr plugin)))
         (cell (and api (assoc name api))))
    (if cell
        (apply (cdr cell) args)
        (error 'unknown-plugin-operation name))))

(define (eval-source source)
  (let ((port (open-input-string source)))
    (let loop ((last #f))
      (let ((form (read port)))
        (if (eof-object? form)
            last
            (loop (eval form (interaction-environment))))))))

(define (register-rule-source! id version source . plugin-ids)
  (when (rule-ref id) (error 'duplicate-rule id))
  (let* ((tree (tree-hash source))
         (proc (eval-source source)))
    (when (not (procedure? proc)) (error 'not-a-procedure id))
    (set! rules
      (cons (cons id (list version proc tree plugin-ids)) rules))
    (list id tree)))

(define (rule-call id . args)
  (let ((rule (rule-ref id)))
    (if rule
        (apply (cadr rule) args)
        (error 'unknown-rule id))))
